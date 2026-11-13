import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  empty,
  location,
  addHash,
  hashKey,
  parse,
  build,
  merge,
  estimate,
  pack,
  unpack,
  compare,
} from "../core.js";

test("64-bit bucket and rank match a bit-string oracle at every precision", () => {
  let seed = 73n;
  for (let p = 4; p <= 14; p++)
    for (let i = 0; i < 300; i++) {
      seed = (seed * 6364136223846793005n + 1n) & ((1n << 64n) - 1n);
      const bits = seed.toString(2).padStart(64, "0"),
        tail = bits.slice(p),
        first = tail.indexOf("1");
      assert.deepEqual(location(seed, p), {
        index: parseInt(bits.slice(0, p), 2),
        rank: first < 0 ? tail.length + 1 : first + 1,
      });
    }
  assert.deepEqual(location(0n, 4), { index: 0, rank: 61 });
  assert.deepEqual(location((1n << 64n) - 1n, 14), { index: 16383, rank: 1 });
});
test("SHA-256 domain separation matches independent Node implementation", async () => {
  for (const key of ["hello", "é", "e\u0301", "🪻", " leading ", '"\\']) {
    const bytes = createHash("sha256")
      .update(JSON.stringify(["sketch-census-v1", key]))
      .digest();
    assert.equal(await hashKey(key), bytes.readBigUInt64BE());
  }
});
test("exact duplicates and input order do not change registers", async () => {
  const keys = Array.from({ length: 500 }, (_, i) => `person-${i}`);
  assert.deepEqual(
    await build([...keys, ...keys], 8),
    await build(keys.toReversed(), 8),
  );
});
test("merge equals direct union and is associative commutative idempotent", async () => {
  const keys = Array.from({ length: 900 }, (_, i) => `row-${i}`);
  const a = await build(keys.slice(0, 400), 9),
    b = await build(keys.slice(200, 700), 9),
    c = await build(keys.slice(600), 9);
  assert.deepEqual(merge(merge(a, b), c), await build(keys, 9));
  assert.deepEqual(merge(a, b), merge(b, a));
  assert.deepEqual(merge(a, a), a);
  assert.deepEqual(merge(merge(a, b), c), merge(a, merge(b, c)));
  assert.throws(() => merge(a, empty(10)), /precision/);
});
test("small counting, harmonic estimates and finite hash saturation", () => {
  const sketch = empty(4);
  assert.equal(estimate(sketch).estimate, 0);
  addHash(sketch, 1n << 59n);
  assert.equal(estimate(sketch).estimate, 16 * Math.log(16 / 15));
  sketch.registers.fill(4);
  assert.equal(estimate(sketch).estimate, 0.673 * 16 * 16);
  sketch.registers.fill(58);
  assert.equal(estimate(sketch).method, "64-bit range correction");
  sketch.registers.fill(61);
  assert.equal(estimate(sketch).estimate, null);
});
test("packed sketches preserve registers and reject corruption or ambiguity", async () => {
  const sketch = await build(["a", "b", "c"], 8),
    raw = await pack(sketch);
  assert.deepEqual(await unpack(raw), sketch);
  await assert.rejects(
    () => unpack({ ...raw, checksum: "0".repeat(64) }),
    /checksum/,
  );
  await assert.rejects(() => unpack({ ...raw, extra: 1 }), /format/);
  await assert.rejects(
    () =>
      unpack({
        ...raw,
        registers: raw.registers.map((r, i) => (i === 0 ? 256 : r)),
      }),
    /register/,
  );
  assert.equal(JSON.stringify(raw).includes('"a"'), false);
});
test("input boundaries preserve spaces and Unicode normalization distinctions", () => {
  assert.deepEqual(parse("a\r\nb\nc\r\n\n a "), ["a", "b", "c", " a "]);
  assert.equal(parse("é\ne\u0301").length, 2);
  assert.deepEqual(parse(""), []);
  for (const text of ["\ud800", "x\t", "a".repeat(129), "x\n".repeat(20001)])
    assert.throws(() => parse(text));
});
test("reference reporting becomes unknown after a sketch import", async () => {
  const result = await compare("a\nb\nb", "b\nc", 8);
  assert.equal(result.a.exact, 2);
  assert.equal(result.union.exact, 3);
  assert.equal(result.exactOverlap, 1);
  const imported = await compare("a\nb", "ignored", 8, result.sketches.b);
  assert.deepEqual(imported.sketches.union, result.sketches.union);
  assert.equal(imported.b.exact, null);
  assert.equal(imported.union.error, null);
  assert.equal(imported.exactOverlap, null);
});
test("typical error is an asymptotic scale, not a bound; deterministic accuracy smoke test", async () => {
  const result = await build(
      Array.from({ length: 8000 }, (_, i) => `fixture-${i}`),
      12,
    ),
    stats = estimate(result);
  assert.ok(Math.abs(stats.estimate - 8000) / 8000 < 0.08);
  assert.equal(stats.typicalRelativeError, 1.04 / 64);
  assert.equal(
    stats.histogram.reduce((a, b) => a + b, 0),
    4096,
  );
});

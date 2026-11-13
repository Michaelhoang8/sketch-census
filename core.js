const DOMAIN = "sketch-census-v1";
const HASH = "sha256-json-domain-first64-be";
const encoder = new TextEncoder();
export function precision(p) {
  if (!Number.isInteger(p) || p < 4 || p > 14)
    throw Error("Precision must be an integer from 4 to 14.");
  return p;
}
export function empty(p) {
  return { p: precision(p), registers: new Uint8Array(2 ** p) };
}
export function validate(sketch) {
  precision(sketch?.p);
  if (
    !(sketch.registers instanceof Uint8Array) ||
    sketch.registers.length !== 2 ** sketch.p ||
    sketch.registers.some((r) => r > 65 - sketch.p)
  )
    throw Error("Invalid register array.");
  return sketch;
}
export function location(hash, p) {
  precision(p);
  if (typeof hash !== "bigint" || hash < 0n || hash >= 1n << 64n)
    throw Error("Expected an unsigned 64-bit hash.");
  const remaining = 64 - p,
    index = Number(hash >> BigInt(remaining));
  const tail = hash & ((1n << BigInt(remaining)) - 1n);
  const rank =
    tail === 0n ? remaining + 1 : remaining - tail.toString(2).length + 1;
  return { index, rank };
}
export function addHash(sketch, hash) {
  const { index, rank } = location(hash, sketch.p);
  sketch.registers[index] = Math.max(sketch.registers[index], rank);
  return { index, rank };
}
export async function hashKey(key) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(JSON.stringify([DOMAIN, key])),
    ),
  );
  let value = 0n;
  for (const byte of bytes.slice(0, 8)) value = (value << 8n) | BigInt(byte);
  return value;
}
export function parse(text) {
  if (typeof text !== "string" || text.length > 1000000)
    throw Error("Each input is limited to one million UTF-16 code units.");
  const keys = text.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
  if (keys.length > 20000)
    throw Error("Use at most 20,000 nonempty lines per dataset.");
  for (const key of keys)
    if (
      key.length > 128 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(key) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        key,
      )
    )
      throw Error(
        "Keys must be 1–128 UTF-16 units without control characters or unpaired surrogates.",
      );
  return keys;
}
export async function build(keys, p) {
  if (!Array.isArray(keys) || keys.length > 20000)
    throw Error("Invalid input key array.");
  // Validate keys without treating embedded line breaks as separate records.
  for (const key of keys)
    if (
      typeof key !== "string" ||
      parse(key).length !== 1 ||
      /[\r\n]/u.test(key)
    )
      throw Error("Invalid key.");
  const sketch = empty(p);
  for (let i = 0; i < keys.length; i += 128) {
    const hashes = await Promise.all(keys.slice(i, i + 128).map(hashKey));
    for (const hash of hashes) addHash(sketch, hash);
  }
  return sketch;
}
export function merge(a, b) {
  validate(a);
  validate(b);
  if (a.p !== b.p)
    throw Error("Merging requires identical precision and hash conventions.");
  return {
    p: a.p,
    registers: a.registers.map((r, i) => Math.max(r, b.registers[i])),
  };
}
export function estimate(sketch) {
  validate(sketch);
  const m = sketch.registers.length;
  const alpha =
    m === 16
      ? 0.673
      : m === 32
        ? 0.697
        : m === 64
          ? 0.709
          : 0.7213 / (1 + 1.079 / m);
  let zeros = 0,
    harmonic = 0;
  const histogram = Array(66 - sketch.p).fill(0);
  for (const r of sketch.registers) {
    zeros += Number(r === 0);
    harmonic += 2 ** -r;
    histogram[r]++;
  }
  const raw = (alpha * m * m) / harmonic,
    space = 2 ** 64;
  let value = raw,
    method = "harmonic estimate";
  if (raw <= 2.5 * m && zeros > 0) {
    value = m * Math.log(m / zeros);
    method = "linear counting";
  } else if (raw > space / 30) {
    value = raw >= space ? null : -space * Math.log1p(-raw / space);
    method =
      value === null ? "hash space saturated" : "64-bit range correction";
  }
  return {
    estimate: value,
    raw,
    method,
    zeros,
    registers: m,
    bytes: m,
    typicalRelativeError: 1.04 / Math.sqrt(m),
    histogram,
  };
}
function payload(sketch) {
  validate(sketch);
  return {
    format: DOMAIN,
    hash: HASH,
    p: sketch.p,
    registers: Array.from(sketch.registers),
  };
}
async function digest(value) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(JSON.stringify(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function pack(sketch) {
  const body = payload(sketch);
  return { ...body, checksum: await digest(body) };
}
export async function unpack(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(",") !== "checksum,format,hash,p,registers" ||
    raw.format !== DOMAIN ||
    raw.hash !== HASH
  )
    throw Error("Unsupported sketch format or hash convention.");
  precision(raw.p);
  if (
    !Array.isArray(raw.registers) ||
    raw.registers.length !== 2 ** raw.p ||
    raw.registers.some((r) => !Number.isInteger(r) || r < 0 || r > 65 - raw.p)
  )
    throw Error("Invalid packed registers.");
  const sketch = { p: raw.p, registers: Uint8Array.from(raw.registers) };
  if (raw.checksum !== (await digest(payload(sketch))))
    throw Error("Sketch checksum does not match.");
  return sketch;
}
export async function compare(aText, bText, p, imported = null) {
  const aKeys = parse(aText),
    bKeys = imported ? null : parse(bText);
  const a = await build(aKeys, p),
    b = imported ? await unpack(imported) : await build(bKeys, p),
    union = merge(a, b);
  const exactA = new Set(aKeys),
    exactB = bKeys ? new Set(bKeys) : null;
  const exactUnion = exactB ? new Set([...exactA, ...exactB]) : null;
  const report = (sketch, exact, rows) => ({
    ...estimate(sketch),
    exact,
    rows,
    error:
      exact === null || exact === 0
        ? null
        : estimate(sketch).estimate === null
          ? null
          : (estimate(sketch).estimate - exact) / exact,
  });
  return {
    format: "sketch-census-evidence-v1",
    p,
    a: report(a, exactA.size, aKeys.length),
    b: report(b, exactB?.size ?? null, bKeys?.length ?? null),
    union: report(union, exactUnion?.size ?? null, null),
    exactOverlap: exactB
      ? [...exactA].filter((k) => exactB.has(k)).length
      : null,
    sketches: { a: await pack(a), b: await pack(b), union: await pack(union) },
  };
}

import { unpack } from "./core.js";
const $ = (id) => document.getElementById(id);
let result = null,
  imported = null,
  busy = false,
  dirty = true;
const count = (n) =>
  n === null
    ? "Unknown"
    : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").className = error ? "error" : "";
}
function controls() {
  document
    .querySelectorAll("button,select,textarea")
    .forEach((e) => (e.disabled = busy));
  $("b").disabled = busy || !!imported;
  $("precision").disabled = busy || !!imported;
  $("export").disabled = $("evidence").disabled = busy || dirty || !result;
}
function invalidate() {
  dirty = true;
  controls();
  notice("Inputs changed. Build again to update the last computed result.");
}
function sample() {
  imported = null;
  $("precision").value = "10";
  $("a").value = Array.from({ length: 3000 }, (_, i) => `visitor-${i}`).join(
    "\n",
  );
  $("b").value = Array.from(
    { length: 4000 },
    (_, i) => `visitor-${i + 2000}`,
  ).join("\n");
  $("import-state").textContent =
    "Both datasets have an exact reference. Empty lines are ignored; spaces and Unicode normalization are preserved.";
  dirty = true;
  controls();
}
function download(name, data) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function svgElement(tag, attributes, text) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes))
    e.setAttribute(key, value);
  if (text !== undefined) e.textContent = text;
  return e;
}
function inspect() {
  if (!result) return;
  const stats = result[$("inspect").value];
  $("method").textContent =
    `${stats.method.toUpperCase()} · ${stats.zeros} EMPTY REGISTERS`;
  const svg = $("histogram");
  svg.replaceChildren();
  const last = Math.max(
      4,
      stats.histogram.findLastIndex((n) => n > 0),
    ),
    bins = stats.histogram.slice(0, last + 1),
    max = Math.max(...bins, 1),
    width = 1000 / bins.length;
  bins.forEach((n, i) => {
    const height = (n / max) * 155,
      x = i * width + 8;
    svg.append(
      svgElement("rect", {
        x,
        y: 180 - height,
        width: Math.max(1, width - 16),
        height,
        rx: 2,
      }),
    );
    svg.append(
      svgElement(
        "text",
        { x: i * width + width / 2, y: 205, "text-anchor": "middle" },
        i,
      ),
    );
    if (n)
      svg.append(
        svgElement(
          "text",
          {
            x: i * width + width / 2,
            y: 172 - height,
            "text-anchor": "middle",
          },
          n,
        ),
      );
  });
  svg.setAttribute(
    "aria-label",
    `Register rank histogram for ${$("inspect").value}: ${bins.map((n, i) => `rank ${i}: ${n}`).join(", ")}`,
  );
}
function render() {
  const s = result.union;
  $("estimate").textContent =
    s.estimate === null ? "Saturated" : count(s.estimate);
  $("memory").textContent = count(s.bytes);
  $("scale").textContent = `${(s.typicalRelativeError * 100).toFixed(2)}%`;
  $("overlap").textContent = count(result.exactOverlap);
  $("explanation").textContent =
    s.exact === null
      ? "Merged from a saved sketch. Exact union and observed error are unknown."
      : `${count(s.exact)} exact distinct keys · ${s.error === null ? "No relative error for an empty reference" : `${s.error >= 0 ? "+" : ""}${(s.error * 100).toFixed(2)}% observed error`} · overlaps counted once.`;
  $("comparison").replaceChildren();
  for (const [key, label] of [
    ["a", "Dataset A"],
    ["b", "Dataset B"],
    ["union", "Merged union"],
  ]) {
    const row = document.createElement("tr"),
      stats = result[key];
    for (const text of [
      label,
      count(stats.estimate),
      count(stats.exact),
      stats.error === null
        ? "—"
        : `${stats.error >= 0 ? "+" : ""}${(stats.error * 100).toFixed(2)}%`,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    $("comparison").append(row);
  }
  inspect();
}
function compute() {
  if (busy) return;
  busy = true;
  dirty = true;
  controls();
  notice("Hashing keys and merging registers in a worker…");
  const worker = new Worker("/worker.js", { type: "module" });
  const finish = () => {
    worker.terminate();
    busy = false;
    controls();
  };
  worker.onmessage = ({ data }) => {
    if (data.error) {
      notice(data.error, true);
      finish();
      return;
    }
    result = data.result;
    dirty = false;
    render();
    notice(
      "Computed locally. Repeated keys and overlapping datasets share the same registers.",
    );
    finish();
  };
  worker.onerror = () => {
    notice("The analysis worker could not finish. Reload and try again.", true);
    finish();
  };
  worker.postMessage({
    a: $("a").value,
    b: $("b").value,
    p: Number($("precision").value),
    imported,
  });
}
$("compute").onclick = compute;
$("sample").onclick = () => {
  sample();
  compute();
};
for (const id of ["a", "b", "precision"])
  $(id).addEventListener("input", invalidate);
$("inspect").onchange = inspect;
$("export").onclick = () => {
  if (!dirty && result)
    download(
      `sketch-census-${$("inspect").value}.json`,
      result.sketches[$("inspect").value],
    );
};
$("evidence").onclick = () => {
  if (!dirty && result) download("sketch-census-evidence.json", result);
};
$("import").onclick = () => $("file").click();
$("file").onchange = async () => {
  const file = $("file").files[0];
  $("file").value = "";
  if (!file || busy) return;
  busy = true;
  controls();
  try {
    if (file.size > 200000) throw Error("Sketch files are limited to 200 KB.");
    const raw = JSON.parse(await file.text());
    await unpack(raw);
    imported = raw;
    $("precision").value = String(raw.p);
    $("b").value = "";
    $("import-state").textContent =
      "Dataset B uses an imported sketch. Precision is fixed to match; exact B, union, and overlap counts are unknown. Reset the example to return to raw inputs.";
    dirty = true;
    notice("Sketch B verified. Build to merge it with dataset A.");
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    controls();
  }
};
sample();
compute();

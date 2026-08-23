// Inspect the JSONL chat session line kinds and reconstruct-ability.
import { readFileSync } from "node:fs";

const file = process.argv[2];
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
console.log("lines:", lines.length);
const kinds = {};
let initial = null;
for (const line of lines) {
  try {
    const obj = JSON.parse(line);
    kinds[obj.kind] = (kinds[obj.kind] ?? 0) + 1;
    if (obj.kind === 0) initial = obj.v;
  } catch {
    kinds.unparsed = (kinds.unparsed ?? 0) + 1;
  }
}
console.log("kinds:", JSON.stringify(kinds));
if (initial) {
  console.log("initial.requests:", initial.requests?.length, "title:", initial.customTitle);
}
// sample kind-2 lines (suspected request appends)
let shown = 0;
for (const line of lines) {
  const obj = JSON.parse(line);
  if (obj.kind !== 2 || shown >= 4) continue;
  const v = obj.v;
  const first = Array.isArray(v) ? v[0] : v;
  console.log(
    "KIND2 sample:",
    Array.isArray(v) ? `array[${v.length}]` : typeof v,
    "keys:",
    Object.keys(first ?? {}).join(",").slice(0, 140),
  );
  if (first?.message?.text) console.log("  msg:", JSON.stringify(first.message.text).slice(0, 90));
  shown++;
}

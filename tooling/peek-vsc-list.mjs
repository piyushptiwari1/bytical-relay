import { VsCodeChatReader } from "../apps/desktop-controller/src/vscode-chats.ts";

const reader = new VsCodeChatReader();
const t0 = Date.now();
const list = reader.list();
console.log("count", list.length, "ms", Date.now() - t0);
for (const c of list.slice(0, 8)) {
  console.log("-", c.id.slice(0, 20), "|", c.title.slice(0, 55), "|", c.workspace_path);
}
const mine = list.find((c) => /remote developer control/i.test(c.title));
console.log(
  "THIS CHAT:",
  mine ? `${mine.id} ws=${mine.workspace_path} turns=${mine.turns}` : "NOT FOUND",
);
if (mine) {
  const t1 = Date.now();
  const tr = reader.transcript(mine.id);
  console.log("transcript turns", tr?.turns.length, "ms", Date.now() - t1);
  console.log("first user:", tr?.turns[0]?.text.slice(0, 80));
  console.log("last turn:", tr?.turns.at(-1)?.role, tr?.turns.at(-1)?.text.slice(0, 80));
}

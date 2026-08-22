// One-shot live E2E probe against a running controller (used by the S1 smoke test).
// Usage: node smoke-ws.mjs <port> <token> <projectDirAbs>
import { writeFileSync } from "node:fs";
import path from "node:path";

const [port, token, projectDir] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
const uuid = () => crypto.randomUUID();
const send = (msg) => ws.send(JSON.stringify(msg));
const queue = [];
const waiters = [];
ws.addEventListener("message", (e) => {
  const v = JSON.parse(e.data);
  const w = waiters.shift();
  w ? w(v) : queue.push(v);
});
const next = () =>
  queue.length
    ? Promise.resolve(queue.shift())
    : new Promise((res, rej) => {
        waiters.push(res);
        setTimeout(() => rej(new Error("timeout")), 8000);
      });
const command = (type, payload) => {
  send({ id: uuid(), type, version: 1, ts: new Date().toISOString(), command_id: uuid(), payload });
  return next();
};

await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
send({
  id: uuid(),
  type: "hello",
  version: 1,
  ts: new Date().toISOString(),
  payload: { protocol: { min: 1, max: 1 }, device_id: "smoke" },
});
const ack = await next();
console.log("hello_ack:", ack.payload.machine_id);

const projects = (await command("project.list", {})).payload.result.projects;
console.log("projects:", projects.map((p) => `${p.name}@v${p.version}`).join(", "));
const project = projects[0];

await command("sync.subscribe", { streams: [`fs:${project.project_id}`] });
console.log("subscribed");

writeFileSync(path.join(projectDir, "smoke-live.txt"), `written ${new Date().toISOString()}`);
const pushed = await next(); // live push, no polling
console.log("live-push:", pushed.type, pushed.payload.change, pushed.payload.relative_path, `seq=${pushed.seq}`);

const replay = (await command("sync.replay", { stream: `fs:${project.project_id}`, since: 0, limit: 100 })).payload
  .result;
console.log("replay:", replay.events.length, "event(s), head_seq =", replay.head_seq);
ws.close();
console.log("SMOKE OK");

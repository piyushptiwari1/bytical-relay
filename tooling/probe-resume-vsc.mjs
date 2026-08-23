// E2 live probe: resume THIS VS Code panel chat via agent.resume (vscode-chat →
// Copilot CLI seeded session), wait for idle, print journal head.
// Usage: node tooling/probe-resume-vsc.mjs <port> <token> <native_id>
const [port, token, nativeId] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
const rand = () => globalThis.crypto.randomUUID();
const pending = new Map();

function command(type, payload, timeoutMs = 120_000) {
  const command_id = rand();
  return new Promise((resolve, reject) => {
    pending.set(command_id, { resolve, reject });
    ws.send(
      JSON.stringify({ id: rand(), type, version: 1, ts: new Date().toISOString(), command_id, payload }),
    );
    setTimeout(() => {
      if (pending.delete(command_id)) reject(new Error(`${type} timeout`));
    }, timeoutMs);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      id: rand(),
      type: "hello",
      version: 1,
      ts: new Date().toISOString(),
      payload: { protocol: { min: 1, max: 1 }, device_id: "probe-resume" },
    }),
  );
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.type === "hello_ack") {
    void run().catch((cause) => {
      console.error("PROBE FAILED:", cause.message);
      process.exit(1);
    });
    return;
  }
  if (msg.command_id && msg.type.endsWith(".result")) {
    const entry = pending.get(msg.command_id);
    if (!entry) return;
    pending.delete(msg.command_id);
    if (msg.payload.status === "ok") entry.resolve(msg.payload.result);
    else entry.reject(new Error(`${msg.type}: ${msg.payload.error.message}`));
  }
});

async function run() {
  console.log("resuming", nativeId, "...");
  const t0 = Date.now();
  const { session } = await command("agent.resume", { provider: "vscode-chat", native_id: nativeId });
  console.log(`resumed → session ${session.session_id} status=${session.status} in ${Date.now() - t0}ms`);

  // Wait for the seeded session to settle to idle (poll agent.list).
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const list = await command("agent.list", {});
    const mine = list.sessions.find((s) => s.session_id === session.session_id);
    if (!mine) continue;
    if (mine.status === "idle" || mine.status === "ended" || mine.status === "error") {
      console.log(`status=${mine.status} title="${mine.title ?? ""}" after ${Date.now() - t0}ms`);
      // Pull journal head via sync.replay
      const replay = await command("sync.replay", {
        stream: `agent:${session.session_id}`,
        since: 0,
        limit: 6,
      });
      for (const ev of replay.events) {
        const body = JSON.stringify(ev.payload ?? ev).slice(0, 110);
        console.log(`  [${ev.seq}] ${ev.payload?.kind ?? ev.type ?? "?"}: ${body}`);
      }
      console.log(`head_seq=${replay.head_seq}`);
      console.log(mine.status === "error" ? "E2 FAIL" : "E2 OK: PROBE PASS");
      process.exit(mine.status === "error" ? 1 : 0);
    }
    if (i % 5 === 0) console.log(`  …waiting (${mine.status})`);
  }
  throw new Error("E2 FAIL: never settled");
}

// One-shot: archive an agent session. Usage: node tooling/probe-archive.mjs <port> <token> <session_id>
const [port, token, sessionId] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
const rand = () => globalThis.crypto.randomUUID();
ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      id: rand(),
      type: "hello",
      version: 1,
      ts: new Date().toISOString(),
      payload: { protocol: { min: 1, max: 1 }, device_id: "probe-archive" },
    }),
  );
});
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.type === "hello_ack") {
    ws.send(
      JSON.stringify({
        id: rand(),
        type: "agent.archive",
        version: 1,
        ts: new Date().toISOString(),
        command_id: rand(),
        payload: { session_id: sessionId },
      }),
    );
    return;
  }
  if (msg.type === "agent.archive.result") {
    console.log(JSON.stringify(msg.payload));
    process.exit(msg.payload.status === "ok" ? 0 : 1);
  }
});
setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 15000);

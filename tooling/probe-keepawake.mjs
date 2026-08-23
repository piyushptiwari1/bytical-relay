// Live probe: toggle keep-awake over /ws and print the result + SetThreadExecutionState echo.
// Usage: node tooling/probe-keepawake.mjs <port> <token> <on|off>
const [port, token, mode] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
const send = (obj) => ws.send(JSON.stringify(obj));
const rand = () => globalThis.crypto.randomUUID();

ws.addEventListener("open", () => {
  send({
    id: rand(),
    type: "hello",
    version: 1,
    ts: new Date().toISOString(),
    payload: { protocol: { min: 1, max: 1 }, device_id: "probe" },
  });
});
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.type === "hello_ack") {
    send({
      id: rand(),
      type: "machine.keep_awake",
      version: 1,
      ts: new Date().toISOString(),
      command_id: rand(),
      payload: { enabled: mode !== "off" },
    });
    return;
  }
  if (msg.type === "machine.keep_awake.result") {
    console.log(JSON.stringify(msg.payload, null, 2));
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => {
  console.error("probe timeout");
  process.exit(1);
}, 8000);

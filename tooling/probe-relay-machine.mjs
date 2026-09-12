// Probe whether a machine is registered on the relay: 4404 = offline (pre-credential), anything else = online.
// Node 24 global WebSocket — no deps.
const machine = process.argv[2];
const url = `wss://ws.relay.bytical.ai/tunnel?role=phone&machine=${encodeURIComponent(machine)}&rt=probe&token=probe`;
const ws = new WebSocket(url);
const t = setTimeout(() => {
  console.log(machine, "timeout");
  process.exit(2);
}, 8000);
ws.addEventListener("close", (ev) => {
  clearTimeout(t);
  console.log(machine, ev.code === 4404 ? "OFFLINE" : `ONLINE (close ${ev.code} ${ev.reason})`);
  process.exit(0);
});
ws.addEventListener("error", () => {
  // close follows with the code
});

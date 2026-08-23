// Live phone-simulator probe: hello → agent.list (expect THIS VS Code chat mapped
// to a project) → terminal create/echo/snapshot/kill. Plaintext local-token client.
// Usage: node tooling/probe-flows.mjs <port> <token>
const [port, token] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
const rand = () => globalThis.crypto.randomUUID();
const pending = new Map();

function command(type, payload) {
  const command_id = rand();
  return new Promise((resolve, reject) => {
    pending.set(command_id, { resolve, reject });
    ws.send(
      JSON.stringify({
        id: rand(),
        type,
        version: 1,
        ts: new Date().toISOString(),
        command_id,
        payload,
      }),
    );
    setTimeout(() => {
      if (pending.delete(command_id)) reject(new Error(`${type} timeout`));
    }, 20_000);
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
      payload: { protocol: { min: 1, max: 1 }, device_id: "probe-flows" },
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
  // ── E1: this VS Code chat is listed and mapped ──
  const list = await command("agent.list", {});
  console.log(`agent.list: ${list.sessions.length} sessions, ${list.external.length} external`);
  const vscodeChats = list.external.filter((e) => e.provider === "vscode-chat");
  console.log(`vscode chats: ${vscodeChats.length}`);
  const thisChat = vscodeChats.find((e) =>
    e.title.toLowerCase().includes("remote developer control"),
  );
  if (!thisChat) {
    console.log("titles:", vscodeChats.slice(0, 6).map((e) => e.title).join(" | "));
    throw new Error("E1 FAIL: this conversation not found in external list");
  }
  console.log(
    `E1 OK: "${thisChat.title}" → project ${thisChat.project_id ?? "UNMAPPED"} (${thisChat.updated_at})`,
  );
  if (!thisChat.project_id) throw new Error("E1 FAIL: chat found but project not mapped");

  // ── E4: terminal round-trip ──
  const shells = await command("terminal.list", {});
  console.log(`terminal shells: ${shells.shells.map((s) => s.id).join(", ")}`);
  const { terminal } = await command("terminal.create", { shell: "cmd" });
  console.log(`terminal created: ${terminal.terminal_id} (${terminal.shell})`);
  await sleep(1500);
  await command("terminal.write", { terminal_id: terminal.terminal_id, data: "echo probe_ok_123\r" });
  await sleep(1500);
  const snapshot = await command("terminal.snapshot", { terminal_id: terminal.terminal_id });
  const text = snapshot.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n");
  if (!text.includes("probe_ok_123")) throw new Error("E4 FAIL: echo not in snapshot");
  console.log(`E4 OK: snapshot ${snapshot.lines.length} lines, echo visible, seq=${snapshot.seq}`);
  await command("terminal.kill", { terminal_id: terminal.terminal_id });
  console.log("terminal killed");

  console.log("PROBE PASS");
  process.exit(0);
}

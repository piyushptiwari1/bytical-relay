// Minimal ACP agent for tests: ndjson JSON-RPC over stdio.
// Flow: initialize → session/new → session/prompt → updates + one permission
// request → (allow → tool completes; reject → tool fails) → end_turn.
import { createInterface } from "node:readline";

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
let nextId = 1000;
const pending = new Map();

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    out({ jsonrpc: "2.0", id, method, params });
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && msg.method === undefined) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "initialize") {
    out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === "session/new") {
    out({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session-1" } });
    return;
  }
  if (msg.method === "session/prompt") {
    const sessionId = msg.params.sessionId;
    const update = (u) =>
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } });
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I will create the file. " },
    });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Write hello.txt",
      kind: "edit",
      status: "pending",
    });
    const outcome = await request("session/request_permission", {
      sessionId,
      toolCall: { title: "Write hello.txt", kind: "edit" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed =
      outcome?.outcome?.outcome === "selected" && outcome.outcome.optionId === "allow";
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: allowed ? "completed" : "failed",
    });
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: allowed ? "Done." : "Skipped." },
    });
    out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});

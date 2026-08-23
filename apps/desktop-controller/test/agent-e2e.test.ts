import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAdapter } from "@rdc/agent-acp";
import { MemoryEventStore } from "@rdc/event-store";
import { FsIndex } from "@rdc/filesystem";
import { agentStream } from "@rdc/protocol";
import { describe, expect, test } from "vitest";
import { AgentManager } from "../src/agent-manager.ts";
import { SessionStore } from "../src/session-store.ts";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "agent-acp",
  "test",
  "fake-agent.mjs",
);

function makeManager() {
  const eventStore = new MemoryEventStore();
  const fsIndex = new FsIndex(":memory:");
  fsIndex.upsertProject({
    project_id: "git_agent",
    name: "agent-proj",
    root_path: process.cwd(),
    vcs: "git",
    fingerprint: "a".repeat(40),
    wsl: false,
  });
  const adapter = new AcpAdapter({
    id: "fake",
    command: process.execPath,
    argsFor: () => [fixture],
  });
  return { manager: new AgentManager({ eventStore, fsIndex }, [adapter]), eventStore };
}

describe("AgentManager end-to-end with scripted ACP agent", () => {
  test("start → stream → approval → respond → idle; journal replayable", async () => {
    const { manager, eventStore } = makeManager();

    const approvals: string[] = [];
    manager.emitter.on("journaled", (records) => {
      for (const record of records) {
        if (record.type === "approval.requested") {
          approvals.push((record.payload as { approval_id: string }).approval_id);
        }
      }
    });

    const session = await manager.start("git_agent", "fake", "create hello.txt");
    expect(session.status).toBe("running");

    // wait until the approval request lands in the journal
    await waitFor(() => approvals.length === 1);
    expect(manager.list()[0]?.status).toBe("awaiting_approval");
    expect(manager.approvals.pendingFor(session.session_id)).toHaveLength(1);

    expect(manager.respond(approvals[0] as string, "allow")).toBe(true);
    await waitFor(() => manager.list()[0]?.status === "idle");

    const journal = eventStore.read(agentStream(session.session_id), 0, 100);
    const types = journal.map((r) => r.type);
    expect(types).toContain("agent.updated");
    expect(types).toContain("approval.requested");
    expect(types).toContain("approval.resolved");
    const updates = journal
      .filter((r) => r.type === "agent.updated")
      .map((r) => (r.payload as { update: { kind: string } }).update.kind);
    expect(updates[0]).toBe("user_message");
    expect(updates).toContain("message_chunk");
    expect(updates).toContain("tool_call");
    expect(updates.at(-1)).toBe("turn_ended");

    // follow-up prompt on an idle session is accepted
    expect(await manager.prompt(session.session_id, "again")).toBe(true);
    await waitFor(() => manager.list()[0]?.status === "awaiting_approval");
    const pending = manager.approvals.pendingFor(session.session_id)[0];
    manager.respond(pending?.approval_id as string, "reject");
    await waitFor(() => manager.list()[0]?.status === "idle");

    await manager.stop();
  });
});

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("SessionStore persistence across controller restarts", () => {
  test("history survives; live sessions become cancelled on boot", () => {
    const store = new SessionStore(":memory:");
    const base = {
      project_id: "git_agent",
      provider: "fake",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.upsert({ ...base, session_id: "ses_done", title: "finished work", status: "completed" });
    store.upsert({ ...base, session_id: "ses_live", title: "was running", status: "running" });
    store.upsert({
      ...base,
      session_id: "ses_wait",
      title: "was waiting",
      status: "awaiting_approval",
    });

    // simulated restart
    expect(store.markInterrupted()).toBe(2);
    const sessions = store.list();
    expect(sessions.find((s) => s.session_id === "ses_done")?.status).toBe("completed");
    expect(sessions.find((s) => s.session_id === "ses_live")?.status).toBe("cancelled");
    expect(sessions.find((s) => s.session_id === "ses_wait")?.status).toBe("cancelled");
    store.close();
  });
});

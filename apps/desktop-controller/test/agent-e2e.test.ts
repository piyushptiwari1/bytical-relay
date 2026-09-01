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
    expect((await manager.prompt(session.session_id, "again")).accepted).toBe(true);
    await waitFor(() => manager.list()[0]?.status === "awaiting_approval");
    const pending = manager.approvals.pendingFor(session.session_id)[0];
    manager.respond(pending?.approval_id as string, "reject");
    await waitFor(() => manager.list()[0]?.status === "idle");

    await manager.stop();
  });

  test("plan mode: mutating permission is auto-denied, never surfaces an approval", async () => {
    const { manager, eventStore } = makeManager();

    const approvals: string[] = [];
    manager.emitter.on("journaled", (records) => {
      for (const record of records) {
        if (record.type === "approval.requested") {
          approvals.push((record.payload as { approval_id: string }).approval_id);
        }
      }
    });

    const session = await manager.start("git_agent", "fake", "plan the hello feature", {
      mode: "plan",
    });
    expect(session.mode).toBe("plan");
    await waitFor(() => manager.list()[0]?.status === "idle");

    // no human approval was ever requested — policy denied the edit outright
    expect(approvals).toHaveLength(0);
    const journal = eventStore.read(agentStream(session.session_id), 0, 200);
    const updates = journal
      .filter((r) => r.type === "agent.updated")
      .map((r) => (r.payload as { update: { kind: string; title?: string } }).update);
    const blocked = updates.find((u) => u.title?.includes("blocked by plan mode"));
    expect(blocked).toBeDefined();
    // the mode preamble told the agent up front
    expect(
      journal.some(
        (r) => r.type === "agent.updated" && JSON.stringify(r.payload).includes("PLAN mode"),
      ),
    ).toBe(true);

    await manager.stop();
  });
});

describe("AgentManager queued prompts", () => {
  test("a prompt sent during an active turn is delivered once that turn completes", async () => {
    const eventStore = new MemoryEventStore();
    const sessions = new SessionStore(":memory:");
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
    const manager = new AgentManager({ eventStore, fsIndex, sessions }, [adapter]);
    const session = await manager.start("git_agent", "fake", "first task");
    await waitFor(() => manager.approvals.pendingFor(session.session_id).length === 1);

    const queued = await manager.prompt(session.session_id, "run the focused tests after this");
    expect(queued).toEqual({ accepted: true, queued: true, queued_prompt_count: 1 });
    expect(manager.list()[0]?.queued_prompt_count).toBe(1);

    const firstApproval = manager.approvals.pendingFor(session.session_id)[0]?.approval_id;
    manager.respond(firstApproval as string, "allow");
    await waitFor(() =>
      manager.approvals
        .pendingFor(session.session_id)
        .some((request) => request.approval_id !== firstApproval),
    );
    const secondApproval = manager.approvals
      .pendingFor(session.session_id)
      .find((request) => request.approval_id !== firstApproval)?.approval_id;
    manager.respond(secondApproval as string, "allow");
    await waitFor(() => manager.list()[0]?.status === "idle");

    expect(manager.list()[0]?.queued_prompt_count).toBe(0);
    const userMessages = eventStore
      .read(agentStream(session.session_id), 0, 500)
      .filter((record) => record.type === "agent.updated")
      .map((record) => record.payload as { update: { kind: string; text?: string } })
      .filter((payload) => payload.update.kind === "user_message")
      .filter((payload) => payload.update.text === "run the focused tests after this");
    expect(userMessages).toHaveLength(1);

    await manager.stop();
    sessions.close();
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
  test("queued prompts are durable, ordered, and removed with their session", () => {
    const store = new SessionStore(":memory:");
    const base = {
      project_id: "git_agent",
      provider: "fake",
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
    };
    store.upsert({ ...base, session_id: "ses_queue", title: "queued work", status: "idle" });
    store.enqueuePrompt("ses_queue", "que_1", "first correction", "2026-08-30T00:01:00.000Z");
    store.enqueuePrompt("ses_queue", "que_2", "second correction", "2026-08-30T00:02:00.000Z");

    expect(store.queuedPromptCount("ses_queue")).toBe(2);
    expect(store.nextQueuedPrompt("ses_queue")?.text).toBe("first correction");
    expect(store.removeQueuedPrompt("que_1")).toBe(true);
    expect(store.nextQueuedPrompt("ses_queue")?.text).toBe("second correction");

    expect(store.delete("ses_queue")).toBe(true);
    expect(store.queuedPromptCount("ses_queue")).toBe(0);
    store.close();
  });

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

  test("VS Code chat model: dead session auto-reattaches on prompt, no duplicate journal", async () => {
    const eventStore = new MemoryEventStore();
    const store = new SessionStore(":memory:");
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
    const managerA = new AgentManager({ eventStore, fsIndex, sessions: store }, [adapter]);
    const session = await managerA.start("git_agent", "fake", "first task");
    await waitFor(() => managerA.approvals.pendingFor(session.session_id).length === 1);
    managerA.respond(
      managerA.approvals.pendingFor(session.session_id)[0]?.approval_id as string,
      "allow",
    );
    await waitFor(() => managerA.list()[0]?.status === "idle");
    await managerA.stop();
    const journalBefore = eventStore.read(agentStream(session.session_id), 0, 500).length;

    // "controller restart": fresh manager, same stores — old session has no live handle
    const managerB = new AgentManager({ eventStore, fsIndex, sessions: store }, [adapter]);
    expect(managerB.list().find((s) => s.session_id === session.session_id)?.status).toBe(
      "cancelled",
    );
    const accepted = await managerB.prompt(session.session_id, "continue please");
    expect(accepted.accepted).toBe(true);
    await waitFor(() => managerB.list()[0]?.status === "awaiting_approval");
    managerB.respond(
      managerB.approvals.pendingFor(session.session_id)[0]?.approval_id as string,
      "reject",
    );
    await waitFor(() => managerB.list()[0]?.status === "idle");

    const journal = eventStore.read(agentStream(session.session_id), 0, 500);
    const updates = journal
      .filter((r) => r.type === "agent.updated")
      .map((r) => (r.payload as { update: { kind: string; text?: string } }).update);
    // session/load replay must NOT re-journal old turns
    expect(updates.filter((u) => u.text === "earlier question")).toHaveLength(0);
    expect(
      updates.filter((u) => u.kind === "user_message" && u.text === "continue please"),
    ).toHaveLength(1);
    expect(journal.length).toBeGreaterThan(journalBefore);

    // resume() with the same native id must reuse, not duplicate
    const again = await managerB.resume("fake", "fake-session-1");
    expect(again.session_id).toBe(session.session_id);
    expect(managerB.list().filter((s) => s.session_id === session.session_id)).toHaveLength(1);

    // archive removes it from the list
    expect(await managerB.archive(session.session_id)).toBe(true);
    expect(managerB.list().find((s) => s.session_id === session.session_id)).toBeUndefined();
    await managerB.stop();
    store.close();
  });
});

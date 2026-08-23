import {
  type AgentAdapter,
  type AgentSessionHandle,
  ApprovalBridge,
  type PermissionAsk,
} from "@rdc/agent-core";
import type { EventStore, StoredEvent } from "@rdc/event-store";
import type { FsIndex } from "@rdc/filesystem";
import {
  type AgentSession,
  type AgentSessionStatus,
  AgentStatusChanged,
  type AgentUpdate,
  AgentUpdated,
  ApprovalRequested,
  ApprovalResolved,
  agentStream,
} from "@rdc/protocol";
import { newEventId, nowIso, TypedEmitter } from "@rdc/shared";
import type { SessionStore } from "./session-store.ts";
import type { VsCodeChatReader } from "./vscode-chats.ts";

interface ManagedSession {
  session: AgentSession;
  handle: AgentSessionHandle | null;
}

const normalizePath = (p: string): string =>
  p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

const SEED_CAP = 24_000;

/** Transcript → context prompt for continuing an imported chat in the CLI. */
function seedPrompt(turns: Array<{ role: "user" | "assistant"; text: string }>): string {
  let body = turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
    .join("\n\n");
  if (body.length > SEED_CAP) body = `…(earlier turns truncated)\n\n${body.slice(-SEED_CAP)}`;
  return [
    "You are continuing a conversation the user previously had in VS Code Copilot Chat about this same project.",
    "Transcript of that conversation:",
    "---",
    body,
    "---",
    "Briefly confirm you have the context (one sentence), then wait for the user's next instruction.",
  ].join("\n");
}

/**
 * Agent lifecycle owner (IMPLEMENTATION-PLAN S4.1): sessions are controller-
 * owned (they survive editors and phones), every update is journaled to
 * `agent:<session_id>` so any device can replay the full transcript, and all
 * permission requests flow through one ApprovalBridge.
 */
export class AgentManager {
  readonly emitter = new TypedEmitter<{
    journaled: StoredEvent[];
    status: AgentSession;
  }>();
  readonly approvals = new ApprovalBridge();
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #adapters = new Map<string, AgentAdapter>();
  #detectCache: Array<{ id: string; available: boolean; detail: string }> | null = null;

  constructor(
    private readonly deps: {
      eventStore: EventStore;
      fsIndex: FsIndex;
      sessions?: SessionStore;
      vscodeChats?: VsCodeChatReader;
    },
    adapters: AgentAdapter[],
  ) {
    for (const adapter of adapters) this.#adapters.set(adapter.id, adapter);
    this.deps.sessions?.markInterrupted();
  }

  async providers(): Promise<Array<{ id: string; available: boolean; detail: string }>> {
    if (!this.#detectCache) {
      const detected = await Promise.all(
        [...this.#adapters.values()].map(async (adapter) => ({
          id: adapter.id,
          ...(await adapter.detect()),
        })),
      );
      // only cache full success — a slow first probe must not stick as "unavailable"
      if (detected.every((d) => d.available)) this.#detectCache = detected;
      else return detected;
    }
    return this.#detectCache;
  }

  list(): AgentSession[] {
    // persisted history (survives restarts) overlaid with live in-memory state
    const live = new Map(
      [...this.#sessions.values()].map((m) => [m.session.session_id, m.session]),
    );
    if (!this.deps.sessions) {
      return [...live.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    return this.deps.sessions.list().map((row) => live.get(row.session_id) ?? row);
  }

  async start(projectId: string, providerId: string, prompt: string): Promise<AgentSession> {
    const adapter = this.#adapters.get(providerId);
    if (!adapter) throw new Error(`unknown agent provider: ${providerId}`);
    const root = this.deps.fsIndex.getProjectRoot(projectId);
    if (!root) throw new Error(`unknown project: ${projectId}`);

    const managed = this.#createManaged(
      projectId,
      providerId,
      prompt.split("\n", 1)[0]?.slice(0, 80) ?? "session",
    );
    managed.handle = await adapter.createSession({
      cwd: root,
      callbacks: this.#callbacksFor(managed),
    });
    this.deps.sessions?.setNativeId(managed.session.session_id, managed.handle.providerSessionId);
    this.#runTurn(managed, prompt);
    return managed.session;
  }

  /** Continue a provider-native (laptop CLI) conversation — full context replays. */
  async resume(providerId: string, nativeId: string): Promise<AgentSession> {
    if (providerId === "vscode-chat") return this.#resumeVsCodeChat(nativeId);
    const adapter = this.#adapters.get(providerId);
    if (!adapter?.resumeSession || !adapter.listNativeSessions) {
      throw new Error(`${providerId} does not support resuming native sessions`);
    }
    const native = (await adapter.listNativeSessions()).find((s) => s.native_id === nativeId);
    if (!native) throw new Error(`unknown ${providerId} session: ${nativeId}`);
    const projectId = this.#projectIdForCwd(native.cwd);
    if (!projectId) throw new Error(`no indexed project for ${native.cwd}`);

    const managed = this.#createManaged(projectId, providerId, native.title.slice(0, 80));
    managed.handle = await adapter.resumeSession({
      nativeId,
      cwd: native.cwd,
      callbacks: this.#callbacksFor(managed),
    });
    this.deps.sessions?.setNativeId(managed.session.session_id, nativeId);
    // session/load replayed the history into the journal; ready for follow-ups
    this.#setStatus(managed, "idle");
    return managed.session;
  }

  /** Provider-native history (laptop chats) mapped onto indexed projects. */
  async externalSessions(): Promise<
    Array<{
      provider: string;
      native_id: string;
      title: string;
      project_id: string | null;
      updated_at: string;
    }>
  > {
    const results: Array<{
      provider: string;
      native_id: string;
      title: string;
      project_id: string | null;
      updated_at: string;
    }> = [];
    const known = this.deps.sessions?.knownNativeIds() ?? new Set<string>();
    for (const adapter of this.#adapters.values()) {
      if (!adapter.listNativeSessions) continue;
      try {
        for (const native of await adapter.listNativeSessions()) {
          if (known.has(native.native_id)) continue;
          results.push({
            provider: adapter.id,
            native_id: native.native_id,
            title: native.title,
            project_id: this.#projectIdForCwd(native.cwd),
            updated_at: native.updated_at,
          });
        }
      } catch {
        // provider store unreadable — skip silently
      }
    }
    // VS Code Copilot Chat panel history (read-only files → continue via Copilot CLI)
    if (this.deps.vscodeChats && this.#adapters.has("copilot")) {
      try {
        for (const chat of this.deps.vscodeChats.list()) {
          if (known.has(chat.id)) continue;
          results.push({
            provider: "vscode-chat",
            native_id: chat.id,
            title: chat.title,
            project_id: this.#projectIdForCwd(chat.workspace_path),
            updated_at: chat.updated_at,
          });
        }
      } catch {
        // storage unreadable — skip silently
      }
    }
    return results.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** Import a VS Code panel chat: journal its turns, then seed a Copilot CLI session with them. */
  async #resumeVsCodeChat(nativeId: string): Promise<AgentSession> {
    const adapter = this.#adapters.get("copilot");
    if (!adapter) throw new Error("copilot adapter unavailable");
    if (!this.deps.vscodeChats) throw new Error("vscode chat reader unavailable");
    this.deps.vscodeChats.list();
    const chat = this.deps.vscodeChats.transcript(nativeId);
    if (!chat) throw new Error("VS Code chat not found or unreadable");
    const projectId = this.#projectIdForCwd(chat.workspacePath);
    if (!projectId) throw new Error(`no indexed project for ${chat.workspacePath}`);
    const root = this.deps.fsIndex.getProjectRoot(projectId);
    if (!root) throw new Error(`unknown project: ${projectId}`);

    const firstUser = chat.turns.find((t) => t.role === "user")?.text ?? "VS Code chat";
    const managed = this.#createManaged(projectId, "copilot", firstUser.slice(0, 80));
    const sessionId = managed.session.session_id;
    // make the old conversation visible on the phone transcript
    for (const turn of chat.turns) {
      this.#journalUpdate(
        sessionId,
        turn.role === "user"
          ? { kind: "user_message", text: turn.text }
          : { kind: "message_chunk", text: turn.text },
      );
    }
    this.#journalUpdate(sessionId, { kind: "turn_ended", stop_reason: "imported from VS Code" });

    managed.handle = await adapter.createSession({
      cwd: root,
      callbacks: this.#callbacksFor(managed),
    });
    this.deps.sessions?.setNativeId(sessionId, nativeId);
    // seed the CLI session with the transcript (capped) — not journaled as a user message
    this.#runTurn(managed, seedPrompt(chat.turns), { journalUser: false });
    return managed.session;
  }

  #createManaged(projectId: string, providerId: string, title: string): ManagedSession {
    const session: AgentSession = {
      session_id: `ses_${newEventId().slice(0, 13)}`,
      project_id: projectId,
      provider: providerId,
      title,
      status: "starting",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    const managed: ManagedSession = { session, handle: null };
    this.#sessions.set(session.session_id, managed);
    this.#announce(managed);
    return managed;
  }

  #callbacksFor(managed: ManagedSession) {
    const sessionId = managed.session.session_id;
    return {
      onUpdate: (update: AgentUpdate) => this.#journalUpdate(sessionId, update),
      onPermission: async (ask: PermissionAsk) => {
        const { request, answer } = this.approvals.create(sessionId, ask);
        this.#journal(sessionId, ApprovalRequested.type, request);
        this.#setStatus(managed, "awaiting_approval");
        const result = await answer;
        this.#setStatus(managed, "running");
        return result;
      },
      onExit: (error: string | null) => {
        if (managed.session.status === "completed" || managed.session.status === "cancelled")
          return;
        if (error) {
          this.#journalUpdate(sessionId, { kind: "error", message: error });
          this.#setStatus(managed, "failed");
        }
      },
    };
  }

  #projectIdForCwd(cwd: string): string | null {
    const normalized = normalizePath(cwd);
    for (const project of this.deps.fsIndex.listProjects()) {
      const root = normalizePath(project.root_path);
      if (normalized === root || normalized.startsWith(`${root}/`)) return project.project_id;
    }
    return null;
  }

  async prompt(sessionId: string, text: string): Promise<boolean> {
    const managed = this.#sessions.get(sessionId);
    if (!managed?.handle) return false;
    if (managed.session.status === "running" || managed.session.status === "awaiting_approval")
      return false;
    this.#runTurn(managed, text);
    return true;
  }

  async cancel(sessionId: string): Promise<boolean> {
    const managed = this.#sessions.get(sessionId);
    if (!managed?.handle) return false;
    this.approvals.cancelForSession(sessionId);
    await managed.handle.cancel();
    this.#setStatus(managed, "cancelled");
    return true;
  }

  respond(approvalId: string, optionId: string): boolean {
    const request = this.approvals.respond(approvalId, optionId);
    if (!request) return false;
    this.#journal(request.session_id, ApprovalResolved.type, {
      approval_id: approvalId,
      session_id: request.session_id,
      option_id: optionId,
    });
    return true;
  }

  async stop(): Promise<void> {
    for (const [, managed] of this.#sessions) {
      this.approvals.cancelForSession(managed.session.session_id);
      await managed.handle?.dispose().catch(() => {});
    }
  }

  #runTurn(managed: ManagedSession, prompt: string, opts: { journalUser?: boolean } = {}): void {
    const sessionId = managed.session.session_id;
    if (opts.journalUser !== false) {
      this.#journalUpdate(sessionId, { kind: "user_message", text: prompt });
    }
    this.#setStatus(managed, "running");
    managed.handle
      ?.prompt(prompt)
      .then(({ stop_reason }) => {
        this.#journalUpdate(sessionId, { kind: "turn_ended", stop_reason });
        if (managed.session.status === "running") this.#setStatus(managed, "idle");
      })
      .catch((cause: unknown) => {
        if (managed.session.status === "cancelled") return;
        this.#journalUpdate(sessionId, {
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
        this.#setStatus(managed, "failed");
      });
  }

  #journalUpdate(sessionId: string, update: AgentUpdate): void {
    this.#journal(sessionId, AgentUpdated.type, { session_id: sessionId, update });
  }

  #journal(sessionId: string, type: string, payload: unknown): void {
    const stored = this.deps.eventStore.append(agentStream(sessionId), [
      { event_id: newEventId(), type, ts: nowIso(), payload },
    ]);
    this.emitter.emit("journaled", stored);
  }

  #setStatus(managed: ManagedSession, status: AgentSessionStatus): void {
    managed.session = { ...managed.session, status, updated_at: nowIso() };
    this.#sessions.set(managed.session.session_id, managed);
    this.#journal(managed.session.session_id, AgentStatusChanged.type, {
      session: managed.session,
    });
    this.#announce(managed);
  }

  #announce(managed: ManagedSession): void {
    this.deps.sessions?.upsert(managed.session);
    this.emitter.emit("status", managed.session);
  }
}

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

interface ManagedSession {
  session: AgentSession;
  handle: AgentSessionHandle | null;
}

const normalizePath = (p: string): string =>
  p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

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
    private readonly deps: { eventStore: EventStore; fsIndex: FsIndex; sessions?: SessionStore },
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
    return results.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
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

  #runTurn(managed: ManagedSession, prompt: string): void {
    const sessionId = managed.session.session_id;
    this.#journalUpdate(sessionId, { kind: "user_message", text: prompt });
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

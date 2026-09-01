import {
  AgentArchive,
  AgentCancel,
  AgentList,
  AgentPrompt,
  AgentResume,
  type AgentSession,
  AgentStart,
  ApprovalRespond,
  agentStream,
  DeviceRotateToken,
  EditorList,
  EditorOpenFile,
  type EditorState,
  eventEnvelopeFromRecord,
  type FileEntry,
  FileList,
  FileRead,
  fsStream,
  GitCommit,
  GitDiffFile,
  GitStage,
  type GitState,
  GitStatus,
  GitUnstage,
  type KeepAwakeState,
  type KnownMessage,
  type MachineHealth,
  MachineKeepAwake,
  MachineStatus,
  NotifyRegister,
  type Project,
  ProjectList,
  SyncReplay,
  TerminalCreate,
  type TerminalInfo,
  TerminalKill,
  TerminalList,
  TerminalResize,
  type TerminalSnapshot,
  TerminalSnapshotCmd,
  TerminalWrite,
} from "@rdc/protocol";
import { fromB64 } from "@rdc/security/client";
import { newCommandId, nowIso } from "@rdc/shared";
import { type ClientState, ControllerClient } from "@rdc/transport";
import { create } from "zustand";
import {
  expoPushTokenOrNull,
  onAgentStatus,
  onPendingApprovalAction,
  pendingApprovalActions,
  removePendingApprovalAction,
} from "./notifications.ts";
import {
  loadMachines,
  pendingAgentPrompts,
  queueAgentPrompt,
  removeMachine,
  removePendingAgentPrompt,
  type StoredMachine,
  type StoredRelay,
  saveMachine,
} from "./storage.ts";

export type MachineStatusResult = MachineHealth & {
  keep_awake: KeepAwakeState;
  scopes?: string[];
  device_token_expires_at?: string | null;
  relay?: StoredRelay | null;
};

export interface MachineRuntime {
  state: ClientState | "unreachable";
  transport?: "direct" | "relay";
  health?: MachineStatusResult;
  projects?: Project[];
  editors?: EditorState[];
  sessions?: AgentSession[];
  pending_prompt_counts?: Record<string, number>;
  last_refreshed_at?: string;
}

// client instances live outside React state — they are not serializable
const clients = new Map<string, ControllerClient>();
const relayFallbacks = new Set<string>();
const lanRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const rotatingDeviceTokens = new Set<string>();
const deliveringApprovalActions = new Set<string>();
const deliveringAgentPrompts = new Set<string>();
const LAN_RETRY_MS = 60_000;
const TOKEN_ROTATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const clientFor = (machineId: string): ControllerClient | undefined =>
  clients.get(machineId);

export function hasScope(scopes: readonly string[] | undefined, scope: string): boolean {
  return scopes?.includes("*") === true || scopes?.includes(scope) === true;
}

function activeRelayTicket(relay: StoredRelay): string | null {
  if (!Array.isArray(relay.tickets)) return null;
  const now = Date.now();
  return (
    relay.tickets.find((ticket) => {
      const notBefore = Date.parse(ticket.not_before);
      const expiresAt = Date.parse(ticket.expires_at);
      return (
        Number.isFinite(notBefore) &&
        Number.isFinite(expiresAt) &&
        notBefore <= now &&
        now < expiresAt
      );
    })?.ticket ?? null
  );
}

interface AppState {
  hydrated: boolean;
  machines: StoredMachine[];
  runtime: Record<string, MachineRuntime>;
  hydrate(): Promise<void>;
  addMachine(machine: StoredMachine): Promise<void>;
  connect(machineId: string, options?: { preferRelay?: boolean }): Promise<void>;
  refreshMachine(machineId: string): Promise<void>;
  toggleAwake(machineId: string): Promise<void>;
  forget(machineId: string): Promise<void>;
}

export const useApp = create<AppState>((set, get) => {
  const patchRuntime = (id: string, patch: Partial<MachineRuntime>) =>
    set((s) => ({
      runtime: { ...s.runtime, [id]: { state: "unreachable", ...s.runtime[id], ...patch } },
    }));

  const fallBackToRelay = (machineId: string, directClient: ControllerClient) => {
    const machine = get().machines.find((item) => item.machine_id === machineId);
    if (!machine?.relay || relayFallbacks.has(machineId) || clients.get(machineId) !== directClient)
      return;
    relayFallbacks.add(machineId);
    clients.delete(machineId);
    directClient.close();
    void get()
      .connect(machineId, { preferRelay: true })
      .finally(() => relayFallbacks.delete(machineId));
  };

  const clearLanRetry = (machineId: string) => {
    const timer = lanRetryTimers.get(machineId);
    if (timer) clearTimeout(timer);
    lanRetryTimers.delete(machineId);
  };

  const scheduleLanRetry = (machineId: string) => {
    clearLanRetry(machineId);
    const timer = setTimeout(() => {
      lanRetryTimers.delete(machineId);
      void tryReturnToLan(machineId);
    }, LAN_RETRY_MS);
    lanRetryTimers.set(machineId, timer);
  };

  const tryReturnToLan = async (machineId: string) => {
    const activeClient = clients.get(machineId);
    const machine = get().machines.find((item) => item.machine_id === machineId);
    if (
      !activeClient ||
      !machine ||
      machine.addrs.length === 0 ||
      get().runtime[machineId]?.transport !== "relay"
    ) {
      return;
    }
    const probe = new ControllerClient({
      url: `${machine.addrs[0]}/ws`,
      token: machine.token,
      deviceId: machine.device_id,
      keys: {
        keypair: { publicKey: fromB64(machine.kx_pub), privateKey: fromB64(machine.kx_priv) },
        controllerKxPub: fromB64(machine.controller_kx_pub),
      },
      backoff: { baseMs: 500, capMs: 15_000 },
    });
    try {
      await probe.connect(6000);
    } catch {
      probe.close();
      scheduleLanRetry(machineId);
      return;
    }
    probe.close();
    if (
      clients.get(machineId) !== activeClient ||
      get().runtime[machineId]?.transport !== "relay"
    ) {
      return;
    }
    clients.delete(machineId);
    activeClient.close();
    await get().connect(machineId);
  };

  const rotateDeviceTokenIfDue = async (
    machineId: string,
    client: ControllerClient,
    status: MachineStatusResult,
  ) => {
    const expiresAt = status.device_token_expires_at;
    const remaining = expiresAt ? Date.parse(expiresAt) - Date.now() : Number.NaN;
    if (
      !Number.isFinite(remaining) ||
      remaining > TOKEN_ROTATE_WINDOW_MS ||
      rotatingDeviceTokens.has(machineId)
    ) {
      return;
    }
    const machine = get().machines.find((item) => item.machine_id === machineId);
    if (!machine) return;
    const previousToken = machine.token;
    rotatingDeviceTokens.add(machineId);
    try {
      const rotated = await client.command(DeviceRotateToken, {});
      const latest = get().machines.find((item) => item.machine_id === machineId);
      if (!latest || latest.token !== previousToken) return;
      const updated = {
        ...latest,
        token: rotated.token,
        token_expires_at: rotated.expires_at,
      };
      await saveMachine(updated);
      set((state) => ({
        machines: state.machines.map((item) => (item.machine_id === machineId ? updated : item)),
      }));
      patchRuntime(machineId, {
        health: { ...status, device_token_expires_at: rotated.expires_at },
      });
    } catch {
      // The current token remains valid; a later refresh can safely try again.
    } finally {
      rotatingDeviceTokens.delete(machineId);
    }
  };

  const refreshPendingPromptCounts = async (machineId: string) => {
    try {
      const pending = await pendingAgentPrompts(machineId);
      const counts: Record<string, number> = {};
      for (const item of pending) {
        counts[item.session_id] = (counts[item.session_id] ?? 0) + 1;
      }
      patchRuntime(machineId, { pending_prompt_counts: counts });
      return pending;
    } catch {
      return [];
    }
  };

  const deliverPendingAgentPrompts = async (machineId: string) => {
    const client = clients.get(machineId);
    if (client?.state !== "ready" || deliveringAgentPrompts.has(machineId)) return;
    deliveringAgentPrompts.add(machineId);
    try {
      for (const item of await refreshPendingPromptCounts(machineId)) {
        if (clients.get(machineId) !== client || client.state !== "ready") break;
        try {
          const result = await client.command(
            AgentPrompt,
            { session_id: item.session_id, prompt: item.prompt },
            { commandId: item.command_id, timeoutMs: 60_000 },
          );
          if (!result.accepted) break;
          await removePendingAgentPrompt(item.command_id);
        } catch {
          // The stable command id lets the next connection retry without duplicating the prompt.
          break;
        }
      }
    } finally {
      deliveringAgentPrompts.delete(machineId);
      void refreshPendingPromptCounts(machineId);
    }
  };

  const deliverPendingApprovalActions = async (machineId: string) => {
    const client = clients.get(machineId);
    if (client?.state !== "ready" || deliveringApprovalActions.has(machineId)) return;
    deliveringApprovalActions.add(machineId);
    try {
      for (const action of await pendingApprovalActions(machineId)) {
        try {
          const result = await client.command(ApprovalRespond, {
            approval_id: action.approval_id,
            option_id: action.option_id,
          });
          // A false result means the approval was answered or expired elsewhere; it is terminal.
          if (typeof result.resolved === "boolean") {
            await removePendingApprovalAction(action.action_id);
          }
        } catch {
          // Preserve this and later actions for the next reconnect.
          break;
        }
      }
    } finally {
      deliveringApprovalActions.delete(machineId);
    }
  };

  onPendingApprovalAction((machineId) => {
    void deliverPendingApprovalActions(machineId);
  });

  return {
    hydrated: false,
    machines: [],
    runtime: {},

    async hydrate() {
      if (get().hydrated) return;
      const machines = await loadMachines();
      set({ machines, hydrated: true });
      for (const machine of machines) void get().connect(machine.machine_id);
    },

    async addMachine(machine) {
      await saveMachine(machine);
      set((s) => ({
        machines: [...s.machines.filter((m) => m.machine_id !== machine.machine_id), machine],
      }));
      await get().connect(machine.machine_id);
    },

    async connect(machineId, options = {}) {
      const machine = get().machines.find((m) => m.machine_id === machineId);
      if (!machine || clients.has(machineId)) return;
      patchRuntime(machineId, { state: "connecting" });
      // direct LAN first (lowest latency), then relay if the machine advertised one
      const directCandidates: Array<{
        url: string;
        transport: "direct" | "relay";
        sendTokenInUrl?: boolean;
      }> = machine.addrs.map((addr) => ({ url: `${addr}/ws`, transport: "direct" }));
      const relayCandidates: Array<{
        url: string;
        transport: "direct" | "relay";
        sendTokenInUrl?: boolean;
      }> = [];
      if (machine.relay) {
        const ticket = activeRelayTicket(machine.relay);
        if (ticket) {
          const base = machine.relay.url.replace(/\/$/, "");
          relayCandidates.push({
            url: `${base}/tunnel?role=phone&machine=${encodeURIComponent(machine.machine_id)}&ticket=${encodeURIComponent(ticket)}`,
            transport: "relay",
            sendTokenInUrl: false,
          });
        }
      }
      const candidates = options.preferRelay
        ? [...relayCandidates, ...directCandidates]
        : [...directCandidates, ...relayCandidates];
      for (const candidate of candidates) {
        const client = new ControllerClient({
          url: candidate.url,
          token: machine.token,
          ...(candidate.sendTokenInUrl === false ? { sendTokenInUrl: false } : {}),
          deviceId: machine.device_id,
          keys: {
            keypair: { publicKey: fromB64(machine.kx_pub), privateKey: fromB64(machine.kx_priv) },
            controllerKxPub: fromB64(machine.controller_kx_pub),
          },
          backoff: { baseMs: 500, capMs: 15_000 },
        });
        try {
          await client.connect(6000);
          clients.set(machineId, client);
          client.events.on("state", (state) => {
            if (clients.get(machineId) !== client) return;
            patchRuntime(machineId, { state });
            if (state === "reconnecting" && candidate.transport === "direct") {
              fallBackToRelay(machineId, client);
            }
            if (state === "ready") {
              void deliverPendingAgentPrompts(machineId);
              void deliverPendingApprovalActions(machineId);
            }
          });
          client.events.on("event", (msg) => {
            if (clients.get(machineId) !== client) return;
            if (msg.type === "machine.health") {
              patchRuntime(machineId, {
                health: { ...get().runtime[machineId]?.health, ...msg.payload },
                last_refreshed_at: new Date().toISOString(),
              });
            }
            if (msg.type === "agent.status_changed") {
              onAgentStatus(machineId, msg.payload.session);
              patchRuntime(machineId, {
                sessions: [
                  msg.payload.session,
                  ...(get().runtime[machineId]?.sessions ?? []).filter(
                    (session) => session.session_id !== msg.payload.session.session_id,
                  ),
                ],
                last_refreshed_at: new Date().toISOString(),
              });
            }
            if (msg.type === "editor.state_changed")
              patchRuntime(machineId, { editors: msg.payload.editors });
          });
          patchRuntime(machineId, { state: client.state, transport: candidate.transport });
          await get().refreshMachine(machineId);
          void deliverPendingAgentPrompts(machineId);
          void deliverPendingApprovalActions(machineId);
          if (candidate.transport === "relay") scheduleLanRetry(machineId);
          else clearLanRetry(machineId);
          // dormant in Expo Go (no token); dev builds register for killed-app push
          void expoPushTokenOrNull()
            .then((token) =>
              token ? client.command(NotifyRegister, { expo_push_token: token }) : null,
            )
            .catch(() => {});
          return;
        } catch {
          client.close();
        }
      }
      patchRuntime(machineId, { state: "unreachable" });
    },

    async refreshMachine(machineId) {
      const client = clients.get(machineId);
      if (!client) return;
      const [health, projects, editors, agentState] = await Promise.all([
        client.command(MachineStatus, {}),
        client.command(ProjectList, {}),
        client.command(EditorList, {}),
        client.command(AgentList, {}).catch(() => null),
      ]);
      patchRuntime(machineId, {
        health,
        projects: projects.projects,
        editors: editors.editors,
        ...(agentState ? { sessions: agentState.sessions } : {}),
        last_refreshed_at: new Date().toISOString(),
      });
      void rotateDeviceTokenIfDue(machineId, client, health as MachineStatusResult);
      // persist newly advertised relay so out-of-home connects work next time
      const machine = get().machines.find((m) => m.machine_id === machineId);
      const advertised = (health as MachineStatusResult).relay ?? null;
      if (machine && JSON.stringify(machine.relay ?? null) !== JSON.stringify(advertised)) {
        const updated = { ...machine, relay: advertised };
        await saveMachine(updated);
        set((s) => ({
          machines: s.machines.map((m) => (m.machine_id === machineId ? updated : m)),
        }));
      }
    },

    async toggleAwake(machineId) {
      const client = clients.get(machineId);
      const current = get().runtime[machineId]?.health;
      if (!client || !current) return;
      const keepAwake = await client.command(MachineKeepAwake, {
        enabled: !current.keep_awake.enabled,
      });
      patchRuntime(machineId, { health: { ...current, keep_awake: keepAwake } });
    },

    async forget(machineId) {
      clearLanRetry(machineId);
      clients.get(machineId)?.close();
      clients.delete(machineId);
      await removeMachine(machineId);
      set((s) => ({
        machines: s.machines.filter((m) => m.machine_id !== machineId),
        runtime: Object.fromEntries(Object.entries(s.runtime).filter(([id]) => id !== machineId)),
      }));
    },
  };
});

// ── project browsing helpers (used by the browser + viewer screens) ──────────

export async function listEntries(
  machineId: string,
  projectId: string,
  parentId: string | null,
): Promise<FileEntry[]> {
  const client = clients.get(machineId);
  if (!client) throw new Error("not connected");
  const result = await client.command(FileList, { project_id: projectId, parent_id: parentId });
  return result.entries;
}

export async function readFile(
  machineId: string,
  projectId: string,
  relativePath: string,
): Promise<{ content: string; encoding: "utf8" | "base64"; size: number; truncated: boolean }> {
  const client = clients.get(machineId);
  if (!client) throw new Error("not connected");
  return client.command(FileRead, { project_id: projectId, relative_path: relativePath });
}

/** Live fs events for one project; returns unsubscribe. */
export function watchProject(
  machineId: string,
  projectId: string,
  onChange: (msg: KnownMessage) => void,
): () => void {
  const client = clients.get(machineId);
  if (!client) return () => {};
  client.subscribe(fsStream(projectId));
  return client.events.on("event", (msg) => {
    if (msg.type === "file.changed" && msg.payload.project_id === projectId) onChange(msg);
  });
}

// ── git helpers (S3) ─────────────────────────────────────────────────────────────

function requireClient(machineId: string) {
  const client = clients.get(machineId);
  if (!client) throw new Error("not connected");
  return client;
}

export const gitStatus = (machineId: string, projectId: string): Promise<GitState> =>
  requireClient(machineId).command(GitStatus, { project_id: projectId });

export const gitDiffFile = (
  machineId: string,
  projectId: string,
  filePath: string,
  staged: boolean,
): Promise<{ path: string; patch: string; binary: boolean; truncated: boolean }> =>
  requireClient(machineId).command(GitDiffFile, {
    project_id: projectId,
    path: filePath,
    staged,
  });

export const gitStage = (
  machineId: string,
  projectId: string,
  paths: string[],
): Promise<GitState> =>
  requireClient(machineId).command(GitStage, { project_id: projectId, paths });

export const gitUnstage = (
  machineId: string,
  projectId: string,
  paths: string[],
): Promise<GitState> =>
  requireClient(machineId).command(GitUnstage, { project_id: projectId, paths });

export const gitCommit = (
  machineId: string,
  projectId: string,
  message: string,
): Promise<{ oid: string; summary: string }> =>
  requireClient(machineId).command(GitCommit, { project_id: projectId, message });

/** Live git status pushes for one project; returns unsubscribe. */
export function watchGit(
  machineId: string,
  projectId: string,
  onStatus: (state: GitState) => void,
): () => void {
  const client = clients.get(machineId);
  if (!client) return () => {};
  return client.events.on("event", (msg) => {
    if (msg.type === "git.status_changed" && msg.payload.project_id === projectId)
      onStatus(msg.payload);
  });
}

/** Ask the desktop editor(s) with this project open to reveal a file. */
export const openInEditor = (
  machineId: string,
  projectId: string,
  relativePath: string,
  line?: number,
): Promise<{ delivered: number }> =>
  requireClient(machineId).command(EditorOpenFile, {
    project_id: projectId,
    relative_path: relativePath,
    ...(line !== undefined ? { line } : {}),
  });

// ── agent helpers (S4) ──────────────────────────────────────────────────────────

export interface ExternalSession {
  provider: string;
  native_id: string;
  title: string;
  project_id: string | null;
  updated_at: string;
}

export const agentList = (
  machineId: string,
): Promise<{
  sessions: AgentSession[];
  providers: Array<{ id: string; available: boolean; detail: string }>;
  external: ExternalSession[];
}> => requireClient(machineId).command(AgentList, {});

export const agentResume = (
  machineId: string,
  provider: string,
  nativeId: string,
): Promise<{ session: AgentSession }> =>
  requireClient(machineId).command(
    AgentResume,
    { provider, native_id: nativeId },
    { timeoutMs: 120_000 },
  );

export const agentStart = (
  machineId: string,
  projectId: string,
  provider: string,
  prompt: string,
  opts: { mode?: "build" | "plan" | "ask"; model?: string } = {},
): Promise<{ session: AgentSession }> =>
  requireClient(machineId).command(
    AgentStart,
    { project_id: projectId, provider, prompt, ...opts },
    {
      timeoutMs: 60_000,
    },
  );

export const agentPrompt = (
  machineId: string,
  sessionId: string,
  prompt: string,
): Promise<{
  accepted: boolean;
  queued: boolean;
  queued_prompt_count: number;
  waiting_to_send?: boolean;
}> => {
  const commandId = newCommandId();
  const saveForLater = async () => {
    await queueAgentPrompt({
      command_id: commandId,
      machine_id: machineId,
      session_id: sessionId,
      prompt,
      created_at: nowIso(),
    });
    const pending = await pendingAgentPrompts(machineId);
    const counts: Record<string, number> = {};
    for (const item of pending) counts[item.session_id] = (counts[item.session_id] ?? 0) + 1;
    useApp.setState((state) => ({
      runtime: {
        ...state.runtime,
        [machineId]: {
          state: "unreachable",
          ...state.runtime[machineId],
          pending_prompt_counts: counts,
        },
      },
    }));
    void useApp.getState().connect(machineId);
    return { accepted: true, queued: true, queued_prompt_count: 0, waiting_to_send: true };
  };

  const client = clients.get(machineId);
  if (client?.state !== "ready") return saveForLater();
  return client
    .command(AgentPrompt, { session_id: sessionId, prompt }, { commandId, timeoutMs: 60_000 })
    .catch((cause: unknown) => {
      if (client.state === "ready") throw cause;
      return saveForLater();
    });
};

export const agentCancel = (
  machineId: string,
  sessionId: string,
): Promise<{ cancelled: boolean }> =>
  requireClient(machineId).command(AgentCancel, { session_id: sessionId });

export const agentArchive = (
  machineId: string,
  sessionId: string,
): Promise<{ archived: boolean }> =>
  requireClient(machineId).command(AgentArchive, { session_id: sessionId });

export const approvalRespond = (
  machineId: string,
  approvalId: string,
  optionId: string,
): Promise<{ resolved: boolean }> =>
  requireClient(machineId).command(ApprovalRespond, {
    approval_id: approvalId,
    option_id: optionId,
  });

/**
 * Full transcript fetch, independent of the live stream cursor — reopening a
 * chat always shows complete history. Returns the events and the last seq so
 * the caller can filter live pushes.
 */
export async function loadAgentTranscript(
  machineId: string,
  sessionId: string,
): Promise<{ events: KnownMessage[]; lastSeq: number }> {
  const client = requireClient(machineId);
  const stream = agentStream(sessionId);
  const events: KnownMessage[] = [];
  let since = 0;
  for (;;) {
    const page = await client.command(SyncReplay, { stream, since, limit: 500 });
    for (const record of page.events) {
      const envelope = eventEnvelopeFromRecord(record);
      if (envelope.ok) events.push(envelope.value);
      since = record.seq;
    }
    if (page.events.length === 0 || since >= page.head_seq) return { events, lastSeq: since };
  }
}

/** Subscribe to a session's journaled stream for live pushes. */
export function watchAgentSession(
  machineId: string,
  sessionId: string,
  onEvent: (msg: KnownMessage) => void,
): () => void {
  const client = clients.get(machineId);
  if (!client) return () => {};
  client.subscribe(agentStream(sessionId));
  return client.events.on("event", (msg) => {
    if ("stream" in msg && msg.stream === agentStream(sessionId)) onEvent(msg);
  });
}

/** Ephemeral broadcast of any session status change on the machine. */
export function watchAgentStatus(
  machineId: string,
  onSession: (session: AgentSession) => void,
): () => void {
  const client = clients.get(machineId);
  if (!client) return () => {};
  return client.events.on("event", (msg) => {
    if (msg.type === "agent.status_changed") onSession(msg.payload.session);
  });
}

// ── terminal helpers (S5) ──────────────────────────────────────────────────

export const terminalList = (
  machineId: string,
): Promise<{ terminals: TerminalInfo[]; shells: Array<{ id: string; label: string }> }> =>
  requireClient(machineId).command(TerminalList, {});

export const terminalCreate = (
  machineId: string,
  opts: { projectId?: string; shell?: string },
): Promise<{ terminal: TerminalInfo }> =>
  requireClient(machineId).command(TerminalCreate, {
    ...(opts.projectId !== undefined ? { project_id: opts.projectId } : {}),
    ...(opts.shell !== undefined ? { shell: opts.shell } : {}),
  });

export const terminalWrite = (
  machineId: string,
  terminalId: string,
  data: string,
): Promise<{ written: boolean }> =>
  requireClient(machineId).command(TerminalWrite, { terminal_id: terminalId, data });

export const terminalSnapshot = (
  machineId: string,
  terminalId: string,
): Promise<TerminalSnapshot> =>
  requireClient(machineId).command(TerminalSnapshotCmd, { terminal_id: terminalId });

export const terminalKill = (machineId: string, terminalId: string): Promise<{ killed: boolean }> =>
  requireClient(machineId).command(TerminalKill, { terminal_id: terminalId });

export const terminalResize = (
  machineId: string,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<{ resized: boolean }> =>
  requireClient(machineId).command(TerminalResize, { terminal_id: terminalId, cols, rows });

/** Output pings for one terminal; returns unsubscribe. */
export function watchTerminal(
  machineId: string,
  terminalId: string,
  onChanged: () => void,
  onClosed?: (exitCode: number | null) => void,
): () => void {
  const client = clients.get(machineId);
  if (!client) return () => {};
  return client.events.on("event", (msg) => {
    if (msg.type === "terminal.changed" && msg.payload.terminal_id === terminalId) onChanged();
    if (msg.type === "terminal.closed" && msg.payload.terminal_id === terminalId)
      onClosed?.(msg.payload.exit_code);
  });
}

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
import { type ClientState, ControllerClient } from "@rdc/transport";
import { create } from "zustand";
import { expoPushTokenOrNull, onAgentStatus } from "./notifications.ts";
import { loadMachines, removeMachine, type StoredMachine, saveMachine } from "./storage.ts";

export type MachineStatusResult = MachineHealth & {
  keep_awake: KeepAwakeState;
  relay?: { url: string; token: string } | null;
};

export interface MachineRuntime {
  state: ClientState | "unreachable";
  transport?: "direct" | "relay";
  health?: MachineStatusResult;
  projects?: Project[];
  editors?: EditorState[];
}

// client instances live outside React state — they are not serializable
const clients = new Map<string, ControllerClient>();
export const clientFor = (machineId: string): ControllerClient | undefined =>
  clients.get(machineId);

interface AppState {
  hydrated: boolean;
  machines: StoredMachine[];
  runtime: Record<string, MachineRuntime>;
  hydrate(): Promise<void>;
  addMachine(machine: StoredMachine): Promise<void>;
  connect(machineId: string): Promise<void>;
  refreshMachine(machineId: string): Promise<void>;
  toggleAwake(machineId: string): Promise<void>;
  forget(machineId: string): Promise<void>;
}

export const useApp = create<AppState>((set, get) => {
  const patchRuntime = (id: string, patch: Partial<MachineRuntime>) =>
    set((s) => ({
      runtime: { ...s.runtime, [id]: { state: "unreachable", ...s.runtime[id], ...patch } },
    }));

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

    async connect(machineId) {
      const machine = get().machines.find((m) => m.machine_id === machineId);
      if (!machine || clients.has(machineId)) return;
      patchRuntime(machineId, { state: "connecting" });
      // direct LAN first (lowest latency), then relay if the machine advertised one
      const candidates: Array<{ url: string; transport: "direct" | "relay" }> = machine.addrs.map(
        (addr) => ({ url: `${addr}/ws`, transport: "direct" }),
      );
      if (machine.relay) {
        const base = machine.relay.url.replace(/\/$/, "");
        candidates.push({
          url: `${base}/tunnel?role=phone&machine=${encodeURIComponent(machine.machine_id)}&rt=${encodeURIComponent(machine.relay.token)}`,
          transport: "relay",
        });
      }
      for (const candidate of candidates) {
        const client = new ControllerClient({
          url: candidate.url,
          token: machine.token,
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
          client.events.on("state", (state) => patchRuntime(machineId, { state }));
          client.events.on("event", (msg) => {
            if (msg.type === "machine.health") patchRuntime(machineId, { health: msg.payload });
            if (msg.type === "agent.status_changed") onAgentStatus(machineId, msg.payload.session);
            if (msg.type === "editor.state_changed")
              patchRuntime(machineId, { editors: msg.payload.editors });
          });
          patchRuntime(machineId, { state: client.state, transport: candidate.transport });
          await get().refreshMachine(machineId);
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
      const [health, projects, editors] = await Promise.all([
        client.command(MachineStatus, {}),
        client.command(ProjectList, {}),
        client.command(EditorList, {}),
      ]);
      patchRuntime(machineId, { health, projects: projects.projects, editors: editors.editors });
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
): Promise<{ session: AgentSession }> =>
  requireClient(machineId).command(
    AgentStart,
    { project_id: projectId, provider, prompt },
    {
      timeoutMs: 60_000,
    },
  );

export const agentPrompt = (
  machineId: string,
  sessionId: string,
  prompt: string,
): Promise<{ accepted: boolean }> =>
  requireClient(machineId).command(AgentPrompt, { session_id: sessionId, prompt });

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

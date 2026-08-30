import { err, ok, type Result, safeJsonParse } from "@rdc/shared";
import { z } from "zod";
import {
  AgentSessionSchema,
  AgentUpdateSchema,
  ApprovalRequestSchema,
  EditorStateSchema,
  FileChangeSchema,
  FileEntrySchema,
  GitStateSchema,
  KeepAwakeStateSchema,
  MachineHealthSchema,
  ProjectSchema,
  TerminalInfoSchema,
  TerminalSnapshotSchema,
} from "./entities.ts";
import { defineCommand, defineEvent, defineMessage } from "./envelope.ts";
import { type ProtocolError, ProtocolErrorSchema, protocolError } from "./errors.ts";
import { PROTOCOL_VERSION } from "./version.ts";

/** Structural twin of the event store's StoredEvent — protocol stays store-agnostic. */
export const EventRecordSchema = z.object({
  stream: z.string().min(1),
  seq: z.number().int().nonnegative(),
  event_id: z.uuid(),
  type: z.string().min(1),
  ts: z.iso.datetime(),
  payload: z.unknown(),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

// ── Handshake ────────────────────────────────────────────────────────────────
export const Hello = defineMessage(
  "hello",
  z.object({
    protocol: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }),
    device_id: z.string().min(1),
    resume: z.record(z.string(), z.number().int().nonnegative()).optional(),
  }),
);

export const HelloAck = defineMessage(
  "hello_ack",
  z.object({
    negotiated_version: z.number().int().positive(),
    machine_id: z.string().min(1),
    server_ts: z.iso.datetime(),
  }),
);

export const HelloReject = defineMessage(
  "hello_reject",
  z.object({
    error: ProtocolErrorSchema,
    supported: z.object({ min: z.number().int(), max: z.number().int() }),
  }),
);

// ── Pairing (S2, exchanged on the unauthenticated /pair endpoint) ───────────
export const PairRequest = defineMessage(
  "pair.request",
  z.object({
    code: z.string().min(4).max(16),
    device_name: z.string().min(1).max(64),
    kx_pub: z.string().min(1),
  }),
);

export const PairPending = defineMessage("pair.pending", z.object({ fingerprint: z.string() }));

export const PairReject = defineMessage(
  "pair.reject",
  z.object({ error: ProtocolErrorSchema, attempts_left: z.number().int().nullable() }),
);

/** payload.sealed = crypto_box(nonce‖cipher) of PairGrant JSON — proves controller identity. */
export const PairGranted = defineMessage("pair.granted", z.object({ sealed: z.string() }));

export const PairGrantSchema = z.object({
  device_id: z.string().min(1),
  token: z.string().min(16),
  token_expires_at: z.iso.datetime(),
  machine_id: z.string().min(1),
  machine_name: z.string().min(1),
  controller_kx_pub: z.string().min(1),
});
export type PairGrant = z.infer<typeof PairGrantSchema>;

/** Payload encoded into the pairing QR shown on the dashboard. */
export const PairQrSchema = z.object({
  v: z.literal(1),
  addrs: z.array(z.string().min(1)).min(1),
  machine_id: z.string().min(1),
  name: z.string().min(1),
  kx_pub: z.string().min(1),
  code: z.string().min(4).max(16),
});
export type PairQr = z.infer<typeof PairQrSchema>;

// ── System ────────────────────────────────────────────────────────────────────
export const SysPing = defineCommand(
  "sys.ping",
  z.object({}),
  z.object({ pong: z.iso.datetime() }),
);

// ── Machine domain (S1.6: health + power control) ─────────────────────────
export const MachineStatus = defineCommand(
  "machine.status",
  z.object({}),
  MachineHealthSchema.extend({
    keep_awake: KeepAwakeStateSchema,
    /** Capabilities granted to this paired device; local owner connections receive `*`. */
    scopes: z.array(z.string()).optional(),
    /** Paired-device token expiry; the raw token is never returned here. */
    device_token_expires_at: z.iso.datetime().nullable().optional(),
    /** Short-lived device-bound relay tickets; the controller credential is never returned. */
    relay: z
      .object({
        url: z.string(),
        tickets: z
          .array(
            z.object({
              ticket: z.string().min(1),
              not_before: z.iso.datetime(),
              expires_at: z.iso.datetime(),
            }),
          )
          .min(1)
          .max(31),
      })
      .nullable()
      .optional(),
  }),
);

export const MachineKeepAwake = defineCommand(
  "machine.keep_awake",
  z.object({ enabled: z.boolean(), ttl_minutes: z.number().int().min(1).max(720).optional() }),
  KeepAwakeStateSchema,
);

/** Replace the current paired device's opaque token over the authenticated E2EE channel. */
export const DeviceRotateToken = defineCommand(
  "device.rotate_token",
  z.object({}),
  z.object({ token: z.string().min(16), expires_at: z.iso.datetime() }),
);

// ── Notifications (S7b: Expo push for killed-app delivery via a dev build) ──
export const NotifyRegister = defineCommand(
  "notify.register",
  z.object({ expo_push_token: z.string().min(8) }),
  z.object({ registered: z.boolean() }),
);

/** Sends a test push to the caller's registered token; returns Expo's ticket. */
export const NotifyTest = defineCommand(
  "notify.test",
  z.object({}),
  z.object({ sent: z.boolean(), ticket: z.string() }),
);

/** Ephemeral telemetry push (not journaled) — stream "machine", seq = broadcast counter. */
export const MachineHealthEvent = defineEvent(
  "machine.health",
  MachineHealthSchema.extend({ keep_awake: KeepAwakeStateSchema }),
);

// ── Debug domain (S0 round-trip proof; pattern for all future domains) ──────
export const DebugEcho = defineCommand(
  "debug.echo",
  z.object({ text: z.string() }),
  z.object({ echoed: z.string() }),
);

export const DebugEchoed = defineEvent(
  "debug.echoed",
  z.object({ text: z.string(), command_id: z.uuid() }),
);

// ── Sync domain ──────────────────────────────────────────────────────────────
export const SyncReplay = defineCommand(
  "sync.replay",
  z.object({
    stream: z.string().min(1),
    since: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(1000).default(200),
  }),
  z.object({
    events: z.array(EventRecordSchema),
    head_seq: z.number().int().nonnegative(),
  }),
);

export const SyncSubscribe = defineCommand(
  "sync.subscribe",
  z.object({ streams: z.array(z.string().min(1)).max(64) }),
  z.object({ subscribed: z.array(z.string()) }),
);

// ── Project / file domain (S1) ───────────────────────────────────────────────
export const ProjectList = defineCommand(
  "project.list",
  z.object({}),
  z.object({ projects: z.array(ProjectSchema) }),
);

export const FileList = defineCommand(
  "file.list",
  z.object({ project_id: z.string().min(1), parent_id: z.uuid().nullable() }),
  z.object({ entries: z.array(FileEntrySchema) }),
);

/** On-demand content fetch (PLAN §7): capped, canonicalized, sensitive-paths denied. */
export const FileRead = defineCommand(
  "file.read",
  z.object({
    project_id: z.string().min(1),
    relative_path: z.string().min(1),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .default(256 * 1024),
  }),
  z.object({
    relative_path: z.string(),
    size: z.number().int().nonnegative(),
    encoding: z.enum(["utf8", "base64"]),
    content: z.string(),
    truncated: z.boolean(),
  }),
);

export const FileChanged = defineEvent("file.changed", FileChangeSchema);

// ── Git domain (S3) ─────────────────────────────────────────────────────────
const projectRef = z.object({ project_id: z.string().min(1) });
const gitPaths = z.array(z.string().min(1)).min(1).max(200);

export const GitStatus = defineCommand("git.status", projectRef, GitStateSchema);

export const GitDiffFile = defineCommand(
  "git.diff_file",
  projectRef.extend({ path: z.string().min(1), staged: z.boolean().default(false) }),
  z.object({
    path: z.string(),
    patch: z.string(),
    binary: z.boolean(),
    truncated: z.boolean(),
  }),
);

export const GitStage = defineCommand(
  "git.stage",
  projectRef.extend({ paths: gitPaths }),
  GitStateSchema,
);

export const GitUnstage = defineCommand(
  "git.unstage",
  projectRef.extend({ paths: gitPaths }),
  GitStateSchema,
);

export const GitCommit = defineCommand(
  "git.commit",
  projectRef.extend({ message: z.string().min(1).max(5000) }),
  z.object({ oid: z.string(), summary: z.string() }),
);

/** Ephemeral push on real status change — stream `git:<project_id>`, not journaled. */
export const GitStatusChanged = defineEvent("git.status_changed", GitStateSchema);

// ── Editor domain (S6: VS Code extension) ─────────────────────────────
/** Extension → controller: full-state upsert for this editor window. */
export const EditorPublishState = defineCommand(
  "editor.publish_state",
  z.object({ state: EditorStateSchema }),
  z.object({ accepted: z.boolean() }),
);

/** Phone → controller: current editors snapshot. */
export const EditorList = defineCommand(
  "editor.list",
  z.object({}),
  z.object({ editors: z.array(EditorStateSchema) }),
);

/** Phone → controller → matching editor(s): open a file on the desktop. */
export const EditorOpenFile = defineCommand(
  "editor.open_file",
  projectRef.extend({
    relative_path: z.string().min(1),
    line: z.number().int().positive().optional(),
  }),
  z.object({ delivered: z.number().int().nonnegative() }),
);

/** Phone → controller → matching editor(s): fire-and-forget chat prompt (no readback). */
export const EditorAskChat = defineCommand(
  "editor.ask_chat",
  projectRef.extend({ query: z.string().min(1).max(4000) }),
  z.object({ delivered: z.number().int().nonnegative() }),
);

/** Controller → phones: editors snapshot changed (ephemeral, stream "editor"). */
export const EditorStateChanged = defineEvent(
  "editor.state_changed",
  z.object({ editors: z.array(EditorStateSchema) }),
);

/** Controller → extension: act on the desktop. */
export const EditorOpenRequested = defineEvent(
  "editor.open_requested",
  projectRef.extend({ relative_path: z.string(), line: z.number().int().positive().nullable() }),
);
export const EditorChatRequested = defineEvent(
  "editor.chat_requested",
  projectRef.extend({ query: z.string() }),
);

// ── Agent domain (S4) ─────────────────────────────────────────────────────
export const AgentStart = defineCommand(
  "agent.start",
  projectRef.extend({ provider: z.string().min(1), prompt: z.string().min(1).max(32_000) }),
  z.object({ session: AgentSessionSchema }),
);

export const AgentPrompt = defineCommand(
  "agent.prompt",
  z.object({ session_id: z.string().min(1), prompt: z.string().min(1).max(32_000) }),
  z.object({
    accepted: z.boolean(),
    queued: z.boolean(),
    queued_prompt_count: z.number().int().nonnegative(),
  }),
);

export const AgentCancel = defineCommand(
  "agent.cancel",
  z.object({ session_id: z.string().min(1) }),
  z.object({ cancelled: z.boolean() }),
);

export const AgentList = defineCommand(
  "agent.list",
  z.object({}),
  z.object({
    sessions: z.array(AgentSessionSchema),
    providers: z.array(z.object({ id: z.string(), available: z.boolean(), detail: z.string() })),
    /** Provider-native history (laptop CLI conversations) not yet attached to an rdc session. */
    external: z.array(
      z.object({
        provider: z.string(),
        native_id: z.string(),
        title: z.string(),
        project_id: z.string().nullable(),
        updated_at: z.string(),
      }),
    ),
  }),
);

/** Continue a provider-native (laptop) conversation with full context. */
export const AgentResume = defineCommand(
  "agent.resume",
  z.object({ provider: z.string().min(1), native_id: z.string().min(1) }),
  z.object({ session: AgentSessionSchema }),
);

/** Remove a conversation from the list (journal kept, CLI history untouched). */
export const AgentArchive = defineCommand(
  "agent.archive",
  z.object({ session_id: z.string().min(1) }),
  z.object({ archived: z.boolean() }),
);

export const ApprovalRespond = defineCommand(
  "approval.respond",
  z.object({ approval_id: z.string().min(1), option_id: z.string().min(1) }),
  z.object({ resolved: z.boolean() }),
);

/** Journaled to `agent:<session_id>` — replayable transcript. */
export const AgentUpdated = defineEvent(
  "agent.updated",
  z.object({ session_id: z.string().min(1), update: AgentUpdateSchema }),
);
export const AgentStatusChanged = defineEvent(
  "agent.status_changed",
  z.object({ session: AgentSessionSchema }),
);
export const ApprovalRequested = defineEvent("approval.requested", ApprovalRequestSchema);
export const ApprovalResolved = defineEvent(
  "approval.resolved",
  z.object({
    approval_id: z.string().min(1),
    session_id: z.string().min(1),
    option_id: z.string(),
  }),
);

// ── Terminal domain (S5) ─────────────────────────────────────────────────────
export const TerminalList = defineCommand(
  "terminal.list",
  z.object({}),
  z.object({
    terminals: z.array(TerminalInfoSchema),
    shells: z.array(z.object({ id: z.string(), label: z.string() })),
  }),
);

export const TerminalCreate = defineCommand(
  "terminal.create",
  z.object({
    project_id: z.string().min(1).optional(),
    shell: z.string().optional(),
    cols: z.number().int().min(20).max(400).optional(),
    rows: z.number().int().min(5).max(200).optional(),
  }),
  z.object({ terminal: TerminalInfoSchema }),
);

export const TerminalWrite = defineCommand(
  "terminal.write",
  z.object({ terminal_id: z.string().min(1), data: z.string().max(16_384) }),
  z.object({ written: z.boolean() }),
);

export const TerminalSnapshotCmd = defineCommand(
  "terminal.snapshot",
  z.object({
    terminal_id: z.string().min(1),
    max_lines: z.number().int().min(10).max(2000).default(400),
  }),
  TerminalSnapshotSchema,
);

export const TerminalResize = defineCommand(
  "terminal.resize",
  z.object({
    terminal_id: z.string().min(1),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
  }),
  z.object({ resized: z.boolean() }),
);

export const TerminalKill = defineCommand(
  "terminal.kill",
  z.object({ terminal_id: z.string().min(1) }),
  z.object({ killed: z.boolean() }),
);

/** Ephemeral pings — the phone refetches a snapshot when viewing that terminal. */
export const TerminalChanged = defineEvent(
  "terminal.changed",
  z.object({ terminal_id: z.string(), seq: z.number().int().nonnegative() }),
);
export const TerminalClosed = defineEvent(
  "terminal.closed",
  z.object({ terminal_id: z.string(), exit_code: z.number().int().nullable() }),
);

// ── Inbound parsing ──────────────────────────────────────────────────────────
export const KnownMessageSchema = z.discriminatedUnion("type", [
  Hello.schema,
  HelloAck.schema,
  HelloReject.schema,
  PairRequest.schema,
  PairPending.schema,
  PairReject.schema,
  PairGranted.schema,
  SysPing.request,
  SysPing.response,
  MachineStatus.request,
  MachineStatus.response,
  MachineKeepAwake.request,
  MachineKeepAwake.response,
  DeviceRotateToken.request,
  DeviceRotateToken.response,
  NotifyRegister.request,
  NotifyRegister.response,
  NotifyTest.request,
  NotifyTest.response,
  MachineHealthEvent.schema,
  DebugEcho.request,
  DebugEcho.response,
  SyncReplay.request,
  SyncReplay.response,
  SyncSubscribe.request,
  SyncSubscribe.response,
  ProjectList.request,
  ProjectList.response,
  FileList.request,
  FileList.response,
  FileRead.request,
  FileRead.response,
  GitStatus.request,
  GitStatus.response,
  GitDiffFile.request,
  GitDiffFile.response,
  GitStage.request,
  GitStage.response,
  GitUnstage.request,
  GitUnstage.response,
  GitCommit.request,
  GitCommit.response,
  EditorPublishState.request,
  EditorPublishState.response,
  EditorList.request,
  EditorList.response,
  EditorOpenFile.request,
  EditorOpenFile.response,
  EditorAskChat.request,
  EditorAskChat.response,
  AgentStart.request,
  AgentStart.response,
  AgentPrompt.request,
  AgentPrompt.response,
  AgentCancel.request,
  AgentCancel.response,
  AgentList.request,
  AgentList.response,
  AgentResume.request,
  AgentResume.response,
  AgentArchive.request,
  AgentArchive.response,
  ApprovalRespond.request,
  ApprovalRespond.response,
  TerminalList.request,
  TerminalList.response,
  TerminalCreate.request,
  TerminalCreate.response,
  TerminalWrite.request,
  TerminalWrite.response,
  TerminalSnapshotCmd.request,
  TerminalSnapshotCmd.response,
  TerminalResize.request,
  TerminalResize.response,
  TerminalKill.request,
  TerminalKill.response,
  DebugEchoed.schema,
  FileChanged.schema,
  GitStatusChanged.schema,
  EditorStateChanged.schema,
  EditorOpenRequested.schema,
  EditorChatRequested.schema,
  AgentUpdated.schema,
  AgentStatusChanged.schema,
  ApprovalRequested.schema,
  ApprovalResolved.schema,
  TerminalChanged.schema,
  TerminalClosed.schema,
]);
export type KnownMessage = z.infer<typeof KnownMessageSchema>;

/** Rebuild the wire envelope for a stored journal record (id/ts preserved). */
export function eventEnvelopeFromRecord(record: EventRecord): Result<KnownMessage, ProtocolError> {
  return parseInbound({
    id: record.event_id,
    type: record.type,
    version: PROTOCOL_VERSION,
    ts: record.ts,
    stream: record.stream,
    seq: record.seq,
    payload: record.payload,
  });
}

/** Validate any inbound wire data (JSON string or already-parsed value). */
export function parseInbound(raw: unknown): Result<KnownMessage, ProtocolError> {
  let value = raw;
  if (typeof raw === "string") {
    const parsed = safeJsonParse(raw);
    if (!parsed.ok) return err(protocolError("INVALID_PAYLOAD", "malformed JSON"));
    value = parsed.value;
  }
  const result = KnownMessageSchema.safeParse(value);
  if (!result.success) {
    return err(protocolError("INVALID_PAYLOAD", z.prettifyError(result.error)));
  }
  return ok(result.data);
}

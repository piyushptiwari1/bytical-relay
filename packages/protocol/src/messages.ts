import { err, ok, type Result, safeJsonParse } from "@rdc/shared";
import { z } from "zod";
import {
  FileChangeSchema,
  FileEntrySchema,
  GitStateSchema,
  KeepAwakeStateSchema,
  MachineHealthSchema,
  ProjectSchema,
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
  MachineHealthSchema.extend({ keep_awake: KeepAwakeStateSchema }),
);

export const MachineKeepAwake = defineCommand(
  "machine.keep_awake",
  z.object({ enabled: z.boolean(), ttl_minutes: z.number().int().min(1).max(720).optional() }),
  KeepAwakeStateSchema,
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
  DebugEchoed.schema,
  FileChanged.schema,
  GitStatusChanged.schema,
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

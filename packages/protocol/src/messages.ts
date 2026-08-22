import { err, ok, type Result, safeJsonParse } from "@rdc/shared";
import { z } from "zod";
import { defineCommand, defineEvent, defineMessage } from "./envelope.ts";
import { type ProtocolError, ProtocolErrorSchema, protocolError } from "./errors.ts";

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

// ── Inbound parsing ──────────────────────────────────────────────────────────
export const KnownMessageSchema = z.discriminatedUnion("type", [
  Hello.schema,
  HelloAck.schema,
  HelloReject.schema,
  DebugEcho.request,
  DebugEcho.response,
  SyncReplay.request,
  SyncReplay.response,
  DebugEchoed.schema,
]);
export type KnownMessage = z.infer<typeof KnownMessageSchema>;

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

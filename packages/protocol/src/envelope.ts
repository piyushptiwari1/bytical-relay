import { newCommandId, newId, nowIso } from "@rdc/shared";
import { z } from "zod";
import { type ProtocolError, ProtocolErrorSchema } from "./errors.ts";
import { PROTOCOL_VERSION } from "./version.ts";

/** Wire envelope: every JSON message on the wire extends this shape (PLAN §26). */
export const EnvelopeBase = z.object({
  id: z.uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  ts: z.iso.datetime(),
  machine_id: z.string().optional(),
  project_id: z.string().optional(),
  session_id: z.string().optional(),
  payload: z.unknown(),
});

export type EnvelopeMeta = Partial<
  Pick<z.infer<typeof EnvelopeBase>, "machine_id" | "project_id" | "session_id">
>;

function baseFields(type: string) {
  return { id: newId(), type, version: PROTOCOL_VERSION, ts: nowIso() };
}

/** Plain (non-command, non-event) message, e.g. handshake. */
export function defineMessage<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  const schema = EnvelopeBase.extend({ type: z.literal(type), payload });
  type Message = z.infer<typeof schema>;
  return {
    type,
    schema,
    create(payloadValue: z.input<TPayload>, meta: EnvelopeMeta = {}): Message {
      return { ...baseFields(type), payload: payloadValue, ...meta } as Message;
    },
  };
}

/**
 * Command = request/response pair. Requests carry a client-generated `command_id`
 * so retries are idempotent (PLAN §18); responses echo it and flag duplicates.
 */
export function defineCommand<
  TName extends string,
  TArgs extends z.ZodType,
  TResult extends z.ZodType,
>(name: TName, args: TArgs, result: TResult) {
  const request = EnvelopeBase.extend({
    type: z.literal(name),
    command_id: z.uuid(),
    payload: args,
  });
  const resultType = `${name}.result` as `${TName}.result`;
  const response = EnvelopeBase.extend({
    type: z.literal(resultType),
    command_id: z.uuid(),
    payload: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), result, duplicate: z.boolean() }),
      z.object({ status: z.literal("error"), error: ProtocolErrorSchema }),
    ]),
  });
  type Request = z.infer<typeof request>;
  type Response = z.infer<typeof response>;
  return {
    name,
    resultType,
    request,
    response,
    createRequest(
      argsValue: z.input<TArgs>,
      opts: EnvelopeMeta & { command_id?: string } = {},
    ): Request {
      const { command_id, ...meta } = opts;
      return {
        ...baseFields(name),
        command_id: command_id ?? newCommandId(),
        payload: argsValue,
        ...meta,
      } as Request;
    },
    createOk(
      commandId: string,
      resultValue: z.infer<TResult>,
      opts: EnvelopeMeta & { duplicate?: boolean } = {},
    ): Response {
      const { duplicate = false, ...meta } = opts;
      return {
        ...baseFields(resultType),
        command_id: commandId,
        payload: { status: "ok", result: resultValue, duplicate },
        ...meta,
      } as Response;
    },
    createError(commandId: string, error: ProtocolError, meta: EnvelopeMeta = {}): Response {
      return {
        ...baseFields(resultType),
        command_id: commandId,
        payload: { status: "error", error },
        ...meta,
      } as Response;
    },
  };
}

/** Event = journal fact with a stream + gap-free sequence assigned by the event store. */
export function defineEvent<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  const schema = EnvelopeBase.extend({
    type: z.literal(type),
    stream: z.string().min(1),
    seq: z.number().int().nonnegative(),
    payload,
  });
  type Event = z.infer<typeof schema>;
  return {
    type,
    schema,
    create(
      stream: string,
      seq: number,
      payloadValue: z.input<TPayload>,
      meta: EnvelopeMeta = {},
    ): Event {
      return { ...baseFields(type), stream, seq, payload: payloadValue, ...meta } as Event;
    },
  };
}

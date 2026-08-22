import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "UPGRADE_REQUIRED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_PAYLOAD",
  "RATE_LIMITED",
  "CONFLICT",
  "TIMEOUT",
  "UNSUPPORTED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ProtocolErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().default(false),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export const protocolError = (
  code: ErrorCode,
  message: string,
  retryable = false,
): ProtocolError => ({
  code,
  message,
  retryable,
});

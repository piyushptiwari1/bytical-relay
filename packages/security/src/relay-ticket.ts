import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const RELAY_TICKET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RELAY_TICKET_BUNDLE_WINDOWS = 14;
const RELAY_TICKET_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface RelayTicketClaims {
  v: 1;
  machine_id: string;
  device_id: string;
  not_before: number;
  expires_at: number;
  nonce: string;
}

/** Opaque bearer ticket a paired phone may present only to the relay. */
export interface RelayAccessTicket {
  ticket: string;
  not_before: string;
  expires_at: string;
}

function sign(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function validClaims(value: unknown): value is RelayTicketClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Partial<RelayTicketClaims>;
  return (
    claims.v === 1 &&
    typeof claims.machine_id === "string" &&
    claims.machine_id.length > 0 &&
    typeof claims.device_id === "string" &&
    claims.device_id.length > 0 &&
    typeof claims.not_before === "number" &&
    Number.isSafeInteger(claims.not_before) &&
    typeof claims.expires_at === "number" &&
    Number.isSafeInteger(claims.expires_at) &&
    claims.expires_at > claims.not_before &&
    typeof claims.nonce === "string" &&
    claims.nonce.length >= 16
  );
}

/** Issue an HMAC-signed relay ticket. The signing secret stays on the relay and controller. */
export function issueRelayTicket(
  secret: string,
  claims: Omit<RelayTicketClaims, "v" | "nonce">,
): RelayAccessTicket {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      ...claims,
      nonce: randomBytes(16).toString("base64url"),
    } satisfies RelayTicketClaims),
  ).toString("base64url");
  const signature = sign(secret, payload).toString("base64url");
  return {
    ticket: `${payload}.${signature}`,
    not_before: new Date(claims.not_before).toISOString(),
    expires_at: new Date(claims.expires_at).toISOString(),
  };
}

/**
 * Issue daily overlapping tickets for an upcoming travel window. Every ticket is short lived;
 * an already connected device receives a fresh bundle on its next `machine.status` refresh.
 */
export function issueRelayTicketBundle(
  secret: string,
  options: {
    machineId: string;
    deviceId: string;
    now?: number;
    windows?: number;
  },
): RelayAccessTicket[] {
  const now = options.now ?? Date.now();
  const windows = options.windows ?? RELAY_TICKET_BUNDLE_WINDOWS;
  const start = Math.floor(now / RELAY_TICKET_WINDOW_MS) * RELAY_TICKET_WINDOW_MS;
  return Array.from({ length: windows }, (_, index) =>
    issueRelayTicket(secret, {
      machine_id: options.machineId,
      device_id: options.deviceId,
      not_before: start + index * RELAY_TICKET_WINDOW_MS - RELAY_TICKET_CLOCK_SKEW_MS,
      expires_at: start + (index + 1) * RELAY_TICKET_WINDOW_MS + RELAY_TICKET_CLOCK_SKEW_MS,
    }),
  );
}

/** Verify signature, ticket shape, and the ticket's active time window. */
export function verifyRelayTicket(
  secret: string,
  ticket: string,
  now = Date.now(),
): RelayTicketClaims | null {
  const parts = ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const expected = sign(secret, parts[0]);
    const presented = Buffer.from(parts[1], "base64url");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      return null;
    }
    const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
    if (!validClaims(claims) || now < claims.not_before || now >= claims.expires_at) return null;
    return claims;
  } catch {
    return null;
  }
}

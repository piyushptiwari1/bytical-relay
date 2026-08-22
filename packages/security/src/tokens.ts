import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Opaque bearer tokens (no JWT by design — nothing to misconfigure, PLAN §19).
 * Only the SHA-256 hash is persisted; the token itself exists client-side only.
 */
export interface TokenRecord {
  token_hash: string;
  device_id: string;
  scopes: readonly string[];
  expires_at: number;
}

export interface IssuedToken {
  token: string;
  record: TokenRecord;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueToken(
  deviceId: string,
  scopes: readonly string[],
  ttlMs: number,
  now = Date.now(),
): IssuedToken {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    record: {
      token_hash: hashToken(token),
      device_id: deviceId,
      scopes: [...scopes],
      expires_at: now + ttlMs,
    },
  };
}

export function verifyToken(record: TokenRecord, presented: string, now = Date.now()): boolean {
  if (now >= record.expires_at) return false;
  const expected = Buffer.from(record.token_hash, "hex");
  const actual = Buffer.from(hashToken(presented), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hasScope(record: TokenRecord, scope: string): boolean {
  return record.scopes.includes(scope);
}

import { createHash } from "node:crypto";
import { stableStringify } from "@rdc/shared";

/** Tamper-evident audit log: each entry hashes its predecessor (PLAN §19). */
export interface AuditEntry {
  ts: string;
  actor: string;
  action: string;
  details?: unknown;
}

export interface ChainedAuditEntry extends AuditEntry {
  seq: number;
  prev_hash: string;
  hash: string;
}

export const GENESIS_HASH = "0".repeat(64);

export function hashAuditEntry(prevHash: string, seq: number, entry: AuditEntry): string {
  return createHash("sha256")
    .update(prevHash)
    .update(String(seq))
    .update(stableStringify(entry))
    .digest("hex");
}

export function appendAuditEntry(chain: ChainedAuditEntry[], entry: AuditEntry): ChainedAuditEntry {
  const prev = chain.at(-1);
  const seq = (prev?.seq ?? 0) + 1;
  const prevHash = prev?.hash ?? GENESIS_HASH;
  const chained: ChainedAuditEntry = {
    ...entry,
    seq,
    prev_hash: prevHash,
    hash: hashAuditEntry(prevHash, seq, entry),
  };
  chain.push(chained);
  return chained;
}

export function verifyAuditChain(
  chain: readonly ChainedAuditEntry[],
): { valid: true } | { valid: false; brokenAt: number } {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const { seq, prev_hash, hash, ...entry } of chain) {
    if (
      seq !== expectedSeq ||
      prev_hash !== prevHash ||
      hashAuditEntry(prevHash, seq, entry) !== hash
    ) {
      return { valid: false, brokenAt: seq };
    }
    prevHash = hash;
    expectedSeq += 1;
  }
  return { valid: true };
}

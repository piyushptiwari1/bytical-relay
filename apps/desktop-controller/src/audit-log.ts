import { DatabaseSync } from "node:sqlite";
import {
  type AuditEntry,
  type ChainedAuditEntry,
  GENESIS_HASH,
  hashAuditEntry,
  verifyAuditChain,
} from "@rdc/security";

/** Persistent, tamper-evident audit history for privileged controller operations. */
export class AuditLog {
  readonly #db: DatabaseSync;

  constructor(dbPath = ":memory:") {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS audit_entries (
        seq INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
    `);
  }

  append(entry: AuditEntry): ChainedAuditEntry {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.#db
        .prepare("SELECT seq, hash FROM audit_entries ORDER BY seq DESC LIMIT 1")
        .get() as { seq: number; hash: string } | undefined;
      const seq = (previous?.seq ?? 0) + 1;
      const prevHash = previous?.hash ?? GENESIS_HASH;
      const chained: ChainedAuditEntry = {
        ...entry,
        seq,
        prev_hash: prevHash,
        hash: hashAuditEntry(prevHash, seq, entry),
      };
      this.#db
        .prepare(
          `INSERT INTO audit_entries (seq, ts, actor, action, details, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chained.seq,
          chained.ts,
          chained.actor,
          chained.action,
          chained.details === undefined ? null : JSON.stringify(chained.details),
          chained.prev_hash,
          chained.hash,
        );
      this.#db.exec("COMMIT");
      return chained;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  entries(limit = 100): ChainedAuditEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM audit_entries ORDER BY seq DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => ({
      seq: row.seq as number,
      ts: row.ts as string,
      actor: row.actor as string,
      action: row.action as string,
      ...(row.details === null ? {} : { details: JSON.parse(row.details as string) }),
      prev_hash: row.prev_hash as string,
      hash: row.hash as string,
    }));
  }

  verify(): ReturnType<typeof verifyAuditChain> {
    return verifyAuditChain(this.entries(Number.MAX_SAFE_INTEGER));
  }

  close(): void {
    this.#db.close();
  }
}

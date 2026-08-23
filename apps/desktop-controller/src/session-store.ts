import { DatabaseSync } from "node:sqlite";
import type { AgentSession } from "@rdc/protocol";

/**
 * Persistent session index (chat history). Transcripts live in the event
 * store (`agent:<id>` streams); this table is the browsable list that
 * survives controller restarts. Sessions left in a live state by a dead
 * controller are marked cancelled on boot.
 */
export class SessionStore {
  readonly #db: DatabaseSync;

  constructor(dbPath = ":memory:") {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    try {
      this.#db.exec("ALTER TABLE agent_sessions ADD COLUMN native_id TEXT");
    } catch {
      // column already exists
    }
  }

  /** Provider-native ids already represented by an rdc session (dedupe). */
  knownNativeIds(): Set<string> {
    const rows = this.#db
      .prepare("SELECT native_id FROM agent_sessions WHERE native_id IS NOT NULL")
      .all() as Array<{ native_id: string }>;
    return new Set(rows.map((r) => r.native_id));
  }

  setNativeId(sessionId: string, nativeId: string): void {
    this.#db
      .prepare("UPDATE agent_sessions SET native_id = ? WHERE session_id = ?")
      .run(nativeId, sessionId);
  }

  nativeIdOf(sessionId: string): string | null {
    const row = this.#db
      .prepare("SELECT native_id FROM agent_sessions WHERE session_id = ?")
      .get(sessionId) as { native_id: string | null } | undefined;
    return row?.native_id ?? null;
  }

  findByNativeId(nativeId: string): AgentSession | undefined {
    const row = this.#db
      .prepare("SELECT * FROM agent_sessions WHERE native_id = ?")
      .get(nativeId) as Record<string, unknown> | undefined;
    return row ? this.#toSession(row) : undefined;
  }

  get(sessionId: string): AgentSession | undefined {
    const row = this.#db
      .prepare("SELECT * FROM agent_sessions WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.#toSession(row) : undefined;
  }

  delete(sessionId: string): boolean {
    const result = this.#db
      .prepare("DELETE FROM agent_sessions WHERE session_id = ?")
      .run(sessionId);
    return Number(result.changes) > 0;
  }

  /** Sessions a previous controller left "live" are dead now. */
  markInterrupted(): number {
    const result = this.#db
      .prepare(
        `UPDATE agent_sessions SET status = 'cancelled'
         WHERE status IN ('starting', 'running', 'awaiting_approval', 'idle')`,
      )
      .run();
    return Number(result.changes);
  }

  upsert(session: AgentSession): void {
    this.#db
      .prepare(
        `INSERT INTO agent_sessions (session_id, project_id, provider, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           title = excluded.title, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(
        session.session_id,
        session.project_id,
        session.provider,
        session.title,
        session.status,
        session.created_at,
        session.updated_at,
      );
  }

  list(limit = 100): AgentSession[] {
    const rows = this.#db
      .prepare("SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.#toSession(r));
  }

  #toSession(r: Record<string, unknown>): AgentSession {
    return {
      session_id: r.session_id as string,
      project_id: r.project_id as string,
      provider: r.provider as string,
      title: r.title as string,
      status: r.status as AgentSession["status"],
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  close(): void {
    this.#db.close();
  }
}

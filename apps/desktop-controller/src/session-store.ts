import { DatabaseSync } from "node:sqlite";
import type { AgentSession } from "@rdc/protocol";

export interface QueuedAgentPrompt {
  prompt_id: string;
  session_id: string;
  text: string;
  created_at: string;
}

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
      CREATE TABLE IF NOT EXISTS queued_agent_prompts (
        prompt_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queued_agent_prompts_by_session
        ON queued_agent_prompts (session_id, created_at, prompt_id);
    `);
    try {
      this.#db.exec("ALTER TABLE agent_sessions ADD COLUMN native_id TEXT");
    } catch {
      // column already exists
    }
    for (const column of ["mode TEXT", "model TEXT"]) {
      try {
        this.#db.exec(`ALTER TABLE agent_sessions ADD COLUMN ${column}`);
      } catch {
        // column already exists
      }
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
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("DELETE FROM queued_agent_prompts WHERE session_id = ?").run(sessionId);
      const result = this.#db
        .prepare("DELETE FROM agent_sessions WHERE session_id = ?")
        .run(sessionId);
      this.#db.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  enqueuePrompt(sessionId: string, promptId: string, text: string, createdAt: string): void {
    this.#db
      .prepare(
        `INSERT INTO queued_agent_prompts (prompt_id, session_id, text, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(promptId, sessionId, text, createdAt);
  }

  nextQueuedPrompt(sessionId: string): QueuedAgentPrompt | undefined {
    const row = this.#db
      .prepare(
        `SELECT prompt_id, session_id, text, created_at
         FROM queued_agent_prompts
         WHERE session_id = ?
         ORDER BY created_at, prompt_id
         LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.#toQueuedPrompt(row) : undefined;
  }

  queuedPromptCount(sessionId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS count FROM queued_agent_prompts WHERE session_id = ?")
      .get(sessionId) as { count: number };
    return row.count;
  }

  removeQueuedPrompt(promptId: string): boolean {
    const result = this.#db
      .prepare("DELETE FROM queued_agent_prompts WHERE prompt_id = ?")
      .run(promptId);
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
        `INSERT INTO agent_sessions (session_id, project_id, provider, title, status, created_at, updated_at, mode, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           title = excluded.title, status = excluded.status, updated_at = excluded.updated_at,
           mode = excluded.mode, model = excluded.model`,
      )
      .run(
        session.session_id,
        session.project_id,
        session.provider,
        session.title,
        session.status,
        session.created_at,
        session.updated_at,
        session.mode ?? null,
        session.model ?? null,
      );
  }

  list(limit = 100): AgentSession[] {
    const rows = this.#db
      .prepare("SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.#toSession(r));
  }

  #toSession(r: Record<string, unknown>): AgentSession {
    const sessionId = r.session_id as string;
    return {
      session_id: sessionId,
      project_id: r.project_id as string,
      provider: r.provider as string,
      title: r.title as string,
      status: r.status as AgentSession["status"],
      ...(r.mode ? { mode: r.mode as AgentSession["mode"] } : {}),
      ...(r.model ? { model: r.model as string } : {}),
      queued_prompt_count: this.queuedPromptCount(sessionId),
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  #toQueuedPrompt(r: Record<string, unknown>): QueuedAgentPrompt {
    return {
      prompt_id: r.prompt_id as string,
      session_id: r.session_id as string,
      text: r.text as string,
      created_at: r.created_at as string,
    };
  }

  close(): void {
    this.#db.close();
  }
}

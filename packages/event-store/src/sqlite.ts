import { DatabaseSync } from "node:sqlite";
import type { EventStore, NewEvent, Snapshot, StoredEvent } from "./types.ts";

/**
 * node:sqlite implementation (zero native deps on Node ≥23.4/24).
 * Swappable with better-sqlite3 behind the same interface if the
 * Phase-0 benchmark demands it (PLAN §40 Q5). WAL + single-writer.
 */
export class SqliteEventStore implements EventStore {
  readonly #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS streams (
        stream TEXT PRIMARY KEY,
        next_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        stream TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (stream, seq)
      );
      CREATE TABLE IF NOT EXISTS cursors (
        device_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (device_id, stream)
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        command_id TEXT PRIMARY KEY,
        result TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        stream TEXT PRIMARY KEY,
        upto_seq INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  append(stream: string, events: readonly NewEvent[]): StoredEvent[] {
    if (events.length === 0) return [];
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          "INSERT INTO streams (stream, next_seq) VALUES (?, ?) ON CONFLICT(stream) DO NOTHING",
        )
        .run(stream, this.headSeq(stream) + 1);
      const row = this.#db.prepare("SELECT next_seq FROM streams WHERE stream = ?").get(stream) as
        | { next_seq: number }
        | undefined;
      let seq = Number(row?.next_seq ?? 1);
      const insert = this.#db.prepare(
        "INSERT INTO events (stream, seq, event_id, type, ts, payload) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const stored: StoredEvent[] = [];
      for (const e of events) {
        insert.run(stream, seq, e.event_id, e.type, e.ts, JSON.stringify(e.payload ?? null));
        stored.push({ ...e, stream, seq });
        seq += 1;
      }
      this.#db.prepare("UPDATE streams SET next_seq = ? WHERE stream = ?").run(seq, stream);
      this.#db.exec("COMMIT");
      return stored;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  read(stream: string, sinceSeq: number, limit = 200): StoredEvent[] {
    const rows = this.#db
      .prepare(
        "SELECT stream, seq, event_id, type, ts, payload FROM events WHERE stream = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(stream, sinceSeq, limit) as Array<{
      stream: string;
      seq: number;
      event_id: string;
      type: string;
      ts: string;
      payload: string;
    }>;
    return rows.map((r) => ({
      stream: r.stream,
      seq: Number(r.seq),
      event_id: r.event_id,
      type: r.type,
      ts: r.ts,
      payload: JSON.parse(r.payload),
    }));
  }

  headSeq(stream: string): number {
    const row = this.#db.prepare("SELECT next_seq FROM streams WHERE stream = ?").get(stream) as
      | { next_seq: number }
      | undefined;
    if (row) return Number(row.next_seq) - 1;
    const snap = this.latestSnapshot(stream);
    return snap?.upto_seq ?? 0;
  }

  getCursor(deviceId: string, stream: string): number {
    const row = this.#db
      .prepare("SELECT seq FROM cursors WHERE device_id = ? AND stream = ?")
      .get(deviceId, stream) as { seq: number } | undefined;
    return row ? Number(row.seq) : 0;
  }

  setCursor(deviceId: string, stream: string, seq: number): void {
    this.#db
      .prepare(
        "INSERT INTO cursors (device_id, stream, seq) VALUES (?, ?, ?) ON CONFLICT(device_id, stream) DO UPDATE SET seq = excluded.seq",
      )
      .run(deviceId, stream, seq);
  }

  getCommandResult(commandId: string, now = Date.now()): unknown {
    this.#db.prepare("DELETE FROM idempotency WHERE expires_at <= ?").run(now);
    const row = this.#db
      .prepare("SELECT result FROM idempotency WHERE command_id = ?")
      .get(commandId) as { result: string } | undefined;
    return row ? JSON.parse(row.result) : undefined;
  }

  putCommandResult(commandId: string, result: unknown, ttlMs: number, now = Date.now()): void {
    this.#db
      .prepare(
        "INSERT INTO idempotency (command_id, result, expires_at) VALUES (?, ?, ?) ON CONFLICT(command_id) DO UPDATE SET result = excluded.result, expires_at = excluded.expires_at",
      )
      .run(commandId, JSON.stringify(result ?? null), now + ttlMs);
  }

  snapshot(stream: string, uptoSeq: number, payload: unknown): void {
    this.#db
      .prepare(
        "INSERT INTO snapshots (stream, upto_seq, payload, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(stream) DO UPDATE SET upto_seq = excluded.upto_seq, payload = excluded.payload, created_at = excluded.created_at",
      )
      .run(stream, uptoSeq, JSON.stringify(payload ?? null), new Date().toISOString());
  }

  latestSnapshot(stream: string): Snapshot | undefined {
    const row = this.#db
      .prepare("SELECT upto_seq, payload FROM snapshots WHERE stream = ?")
      .get(stream) as { upto_seq: number; payload: string } | undefined;
    return row ? { upto_seq: Number(row.upto_seq), payload: JSON.parse(row.payload) } : undefined;
  }

  compact(stream: string): number {
    const snap = this.latestSnapshot(stream);
    if (!snap) return 0;
    const info = this.#db
      .prepare("DELETE FROM events WHERE stream = ? AND seq <= ?")
      .run(stream, snap.upto_seq);
    return Number(info.changes);
  }

  close(): void {
    this.#db.close();
  }
}

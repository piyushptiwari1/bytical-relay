export interface NewEvent {
  event_id: string;
  type: string;
  ts: string;
  payload: unknown;
}

export interface StoredEvent extends NewEvent {
  stream: string;
  seq: number;
}

export interface Snapshot {
  upto_seq: number;
  payload: unknown;
}

/**
 * Append-only journal with gap-free per-stream sequences (single-writer),
 * per-device replay cursors, command idempotency, and snapshot compaction.
 * Sync API by design: both backends (memory, node:sqlite) are synchronous;
 * the transport layer owns async boundaries.
 */
export interface EventStore {
  /** Appends atomically; assigned seqs are contiguous starting at headSeq+1. */
  append(stream: string, events: readonly NewEvent[]): StoredEvent[];
  read(stream: string, sinceSeq: number, limit?: number): StoredEvent[];
  headSeq(stream: string): number;

  getCursor(deviceId: string, stream: string): number;
  setCursor(deviceId: string, stream: string, seq: number): void;

  /** Idempotency cache: replayed command_ids return the original result (PLAN §18). */
  getCommandResult(commandId: string, now?: number): unknown;
  putCommandResult(commandId: string, result: unknown, ttlMs: number, now?: number): void;

  snapshot(stream: string, uptoSeq: number, payload: unknown): void;
  latestSnapshot(stream: string): Snapshot | undefined;
  /** Deletes events covered by the latest snapshot; returns deleted count. */
  compact(stream: string): number;

  close(): void;
}

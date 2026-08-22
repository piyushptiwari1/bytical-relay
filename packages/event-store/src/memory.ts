import type { EventStore, NewEvent, Snapshot, StoredEvent } from "./types.ts";

interface IdempotencyRecord {
  result: unknown;
  expiresAt: number;
}

/** Reference implementation — also reused by the phone-side projection cache tests. */
export class MemoryEventStore implements EventStore {
  #events = new Map<string, StoredEvent[]>();
  #cursors = new Map<string, number>();
  #idempotency = new Map<string, IdempotencyRecord>();
  #snapshots = new Map<string, Snapshot>();

  append(stream: string, events: readonly NewEvent[]): StoredEvent[] {
    const list = this.#events.get(stream) ?? [];
    let seq = this.headSeq(stream);
    const stored = events.map((e) => ({ ...e, stream, seq: ++seq }));
    list.push(...stored);
    this.#events.set(stream, list);
    return stored;
  }

  read(stream: string, sinceSeq: number, limit = 200): StoredEvent[] {
    const list = this.#events.get(stream) ?? [];
    return list.filter((e) => e.seq > sinceSeq).slice(0, limit);
  }

  headSeq(stream: string): number {
    const list = this.#events.get(stream);
    const last = list?.at(-1);
    if (last) return last.seq;
    return this.#snapshots.get(stream)?.upto_seq ?? 0;
  }

  getCursor(deviceId: string, stream: string): number {
    return this.#cursors.get(`${deviceId}\u0000${stream}`) ?? 0;
  }

  setCursor(deviceId: string, stream: string, seq: number): void {
    this.#cursors.set(`${deviceId}\u0000${stream}`, seq);
  }

  getCommandResult(commandId: string, now = Date.now()): unknown {
    const record = this.#idempotency.get(commandId);
    if (!record) return undefined;
    if (now >= record.expiresAt) {
      this.#idempotency.delete(commandId);
      return undefined;
    }
    return record.result;
  }

  putCommandResult(commandId: string, result: unknown, ttlMs: number, now = Date.now()): void {
    this.#idempotency.set(commandId, { result, expiresAt: now + ttlMs });
  }

  snapshot(stream: string, uptoSeq: number, payload: unknown): void {
    this.#snapshots.set(stream, { upto_seq: uptoSeq, payload });
  }

  latestSnapshot(stream: string): Snapshot | undefined {
    return this.#snapshots.get(stream);
  }

  compact(stream: string): number {
    const snap = this.#snapshots.get(stream);
    if (!snap) return 0;
    const list = this.#events.get(stream) ?? [];
    const kept = list.filter((e) => e.seq > snap.upto_seq);
    const removed = list.length - kept.length;
    this.#events.set(stream, kept);
    return removed;
  }

  close(): void {
    this.#events.clear();
    this.#cursors.clear();
    this.#idempotency.clear();
    this.#snapshots.clear();
  }
}

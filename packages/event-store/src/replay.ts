import type { EventStore, StoredEvent } from "./types.ts";

/** Batched replay from a cursor — the transport layer drains this after reconnect. */
export function* replay(
  store: EventStore,
  stream: string,
  fromSeq: number,
  batchSize = 200,
): Generator<StoredEvent[], void, undefined> {
  let cursor = fromSeq;
  for (;;) {
    const batch = store.read(stream, cursor, batchSize);
    if (batch.length === 0) return;
    yield batch;
    cursor = batch[batch.length - 1]!.seq;
    if (batch.length < batchSize) return;
  }
}

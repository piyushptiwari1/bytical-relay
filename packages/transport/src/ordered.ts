/**
 * Gap-free ordered delivery per stream: events are delivered strictly in seq
 * order; duplicates (seq ≤ cursor) are dropped; out-of-order arrivals are
 * buffered until replay fills the gap (IMPLEMENTATION-PLAN S2.1 resume design).
 */
export class OrderedStreamBuffer<T> {
  #cursor: number;
  #buffer = new Map<number, T>();

  constructor(startCursor = 0) {
    this.#cursor = startCursor;
  }

  get cursor(): number {
    return this.#cursor;
  }

  get bufferedCount(): number {
    return this.#buffer.size;
  }

  /** Returns the items that became deliverable (possibly none, possibly several). */
  push(seq: number, item: T): T[] {
    if (seq <= this.#cursor) return [];
    if (seq > this.#cursor + 1) {
      this.#buffer.set(seq, item);
      return [];
    }
    const out: T[] = [item];
    this.#cursor = seq;
    let next = this.#buffer.get(this.#cursor + 1);
    while (next !== undefined) {
      this.#buffer.delete(this.#cursor + 1);
      this.#cursor += 1;
      out.push(next);
      next = this.#buffer.get(this.#cursor + 1);
    }
    return out;
  }
}

export type EventMap = Record<string, unknown>;

type Listener<P> = (payload: P) => void;

export class TypedEmitter<M extends EventMap> {
  #listeners = new Map<keyof M, Set<Listener<never>>>();

  on<K extends keyof M>(type: K, fn: Listener<M[K]>): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn as Listener<never>);
    return () => this.off(type, fn);
  }

  off<K extends keyof M>(type: K, fn: Listener<M[K]>): void {
    this.#listeners.get(type)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.#listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) (fn as Listener<M[K]>)(payload);
  }

  listenerCount(type: keyof M): number {
    return this.#listeners.get(type)?.size ?? 0;
  }
}

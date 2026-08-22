import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  type EventStore,
  MemoryEventStore,
  type NewEvent,
  replay,
  SqliteEventStore,
} from "../src/index.ts";

let counter = 0;
function makeEvent(type = "test.event", payload: unknown = { n: counter }): NewEvent {
  counter += 1;
  // deterministic unique ids are fine here; real ids are UUIDv7 from @rdc/shared
  return {
    event_id: `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    type,
    ts: new Date().toISOString(),
    payload,
  };
}

const implementations: Array<[string, () => EventStore]> = [
  ["memory", () => new MemoryEventStore()],
  ["sqlite", () => new SqliteEventStore(":memory:")],
];

for (const [name, make] of implementations) {
  describe(`EventStore conformance: ${name}`, () => {
    test("append assigns contiguous seqs starting at 1", () => {
      const store = make();
      const stored = store.append("s1", [makeEvent(), makeEvent(), makeEvent()]);
      expect(stored.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(store.headSeq("s1")).toBe(3);
      store.close();
    });

    test("streams are independent", () => {
      const store = make();
      store.append("a", [makeEvent()]);
      store.append("b", [makeEvent(), makeEvent()]);
      expect(store.headSeq("a")).toBe(1);
      expect(store.headSeq("b")).toBe(2);
      expect(store.headSeq("missing")).toBe(0);
      store.close();
    });

    test("read(since) pages forward and respects limit", () => {
      const store = make();
      store.append(
        "s",
        Array.from({ length: 10 }, () => makeEvent()),
      );
      const page = store.read("s", 4, 3);
      expect(page.map((e) => e.seq)).toEqual([5, 6, 7]);
      expect(store.read("s", 10)).toEqual([]);
      store.close();
    });

    test("payloads survive round-trip", () => {
      const store = make();
      const payload = { nested: { arr: [1, "two", null], flag: true } };
      store.append("s", [makeEvent("t", payload)]);
      expect(store.read("s", 0)[0]?.payload).toEqual(payload);
      store.close();
    });

    test("device cursors persist and default to 0", () => {
      const store = make();
      expect(store.getCursor("dev1", "s")).toBe(0);
      store.setCursor("dev1", "s", 42);
      store.setCursor("dev1", "s", 43);
      expect(store.getCursor("dev1", "s")).toBe(43);
      expect(store.getCursor("dev2", "s")).toBe(0);
      store.close();
    });

    test("idempotency cache returns original result until TTL expires", () => {
      const store = make();
      const t0 = 1_000_000;
      store.putCommandResult("cmd_1", { echoed: "hi" }, 5_000, t0);
      expect(store.getCommandResult("cmd_1", t0 + 4_999)).toEqual({ echoed: "hi" });
      expect(store.getCommandResult("cmd_1", t0 + 5_000)).toBeUndefined();
      expect(store.getCommandResult("never", t0)).toBeUndefined();
      store.close();
    });

    test("snapshot + compact removes covered events, seq keeps growing", () => {
      const store = make();
      store.append(
        "s",
        Array.from({ length: 5 }, () => makeEvent()),
      );
      store.snapshot("s", 3, { tree: "state@3" });
      expect(store.compact("s")).toBe(3);
      expect(store.read("s", 0).map((e) => e.seq)).toEqual([4, 5]);
      expect(store.latestSnapshot("s")?.upto_seq).toBe(3);
      const next = store.append("s", [makeEvent()]);
      expect(next[0]?.seq).toBe(6);
      store.close();
    });

    test("property: seqs are gap-free across arbitrary batch sizes", () => {
      fc.assert(
        fc.property(fc.array(fc.integer({ min: 1, max: 7 }), { maxLength: 12 }), (batches) => {
          const store = make();
          try {
            const seqs: number[] = [];
            for (const size of batches) {
              for (const e of store.append(
                "p",
                Array.from({ length: size }, () => makeEvent()),
              )) {
                seqs.push(e.seq);
              }
            }
            return seqs.every((s, i) => s === i + 1);
          } finally {
            store.close();
          }
        }),
        { numRuns: 25 },
      );
    });

    test("replay generator batches from a cursor", () => {
      const store = make();
      store.append(
        "s",
        Array.from({ length: 7 }, () => makeEvent()),
      );
      const batches = [...replay(store, "s", 2, 2)].map((b) => b.map((e) => e.seq));
      expect(batches).toEqual([[3, 4], [5, 6], [7]]);
      store.close();
    });
  });
}

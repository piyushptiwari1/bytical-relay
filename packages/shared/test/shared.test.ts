import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  andThen,
  err,
  isErr,
  isOk,
  map,
  newId,
  nextDelayMs,
  ok,
  safeJsonParse,
  stableStringify,
  TypedEmitter,
  unwrap,
  unwrapOr,
} from "../src/index.ts";

describe("Result", () => {
  test("ok/err discrimination and combinators", () => {
    const a = ok(2);
    expect(isOk(a)).toBe(true);
    expect(
      unwrapOr(
        map(a, (n) => n * 2),
        0,
      ),
    ).toBe(4);

    const b = err(new Error("boom"));
    expect(isErr(b)).toBe(true);
    expect(unwrapOr<number, Error>(b, 7)).toBe(7);
    expect(() => unwrap(b)).toThrow("boom");

    const chained = andThen(ok(3), (n) => (n > 2 ? ok(n) : err(new Error("small"))));
    expect(isOk(chained)).toBe(true);
  });
});

describe("ids", () => {
  test("uuidv7 is time-ordered across ticks", async () => {
    const first = newId();
    await new Promise((r) => setTimeout(r, 5));
    const second = newId();
    expect(second > first).toBe(true);
  });
});

describe("backoff", () => {
  test("stays within [base, cap] for any prev and rng", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 120_000, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
        (prev, rng) => {
          const d = nextDelayMs(prev, { baseMs: 250, capMs: 30_000 }, () => rng);
          return d >= 250 && d <= 30_000;
        },
      ),
    );
  });

  test("grows from previous delay", () => {
    const d = nextDelayMs(1000, { baseMs: 250, capMs: 30_000 }, () => 1);
    expect(d).toBe(3000);
  });
});

describe("json", () => {
  test("stableStringify sorts keys recursively", () => {
    const a = stableStringify({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } });
    const b = stableStringify({ a: { c: [{ y: 2, z: 1 }], d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  test("safeJsonParse returns Err on invalid input", () => {
    expect(isErr(safeJsonParse("{nope"))).toBe(true);
    const parsed = safeJsonParse('{"x":1}');
    expect(isOk(parsed) && (parsed.value as { x: number }).x === 1).toBe(true);
  });
});

describe("TypedEmitter", () => {
  test("on/emit/off with unsubscribe handle", () => {
    const em = new TypedEmitter<{ ping: number }>();
    const seen: number[] = [];
    const off = em.on("ping", (n) => seen.push(n));
    em.emit("ping", 1);
    off();
    em.emit("ping", 2);
    expect(seen).toEqual([1]);
    expect(em.listenerCount("ping")).toBe(0);
  });
});

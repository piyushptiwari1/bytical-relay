import { describe, expect, test } from "vitest";
import { OrderedStreamBuffer } from "../src/ordered.ts";

describe("OrderedStreamBuffer", () => {
  test("in-order delivery advances cursor", () => {
    const buf = new OrderedStreamBuffer<string>(0);
    expect(buf.push(1, "a")).toEqual(["a"]);
    expect(buf.push(2, "b")).toEqual(["b"]);
    expect(buf.cursor).toBe(2);
  });

  test("duplicates and stale seqs are dropped", () => {
    const buf = new OrderedStreamBuffer<string>(5);
    expect(buf.push(3, "old")).toEqual([]);
    expect(buf.push(5, "dupe")).toEqual([]);
    expect(buf.push(6, "next")).toEqual(["next"]);
  });

  test("out-of-order arrivals buffer until the gap fills, then drain in order", () => {
    const buf = new OrderedStreamBuffer<string>(0);
    expect(buf.push(3, "c")).toEqual([]);
    expect(buf.push(2, "b")).toEqual([]);
    expect(buf.bufferedCount).toBe(2);
    expect(buf.push(1, "a")).toEqual(["a", "b", "c"]);
    expect(buf.cursor).toBe(3);
    expect(buf.bufferedCount).toBe(0);
  });

  test("replay + live push interleave delivers exactly once", () => {
    const buf = new OrderedStreamBuffer<string>(2);
    // live pushes arrive while replay is in flight
    expect(buf.push(5, "live5")).toEqual([]);
    expect(buf.push(6, "live6")).toEqual([]);
    // replay fills 3..5 (5 duplicates the buffered live push — buffered wins, no dupe)
    expect(buf.push(3, "replay3")).toEqual(["replay3"]);
    expect(buf.push(4, "replay4")).toEqual(["replay4", "live5", "live6"]);
    expect(buf.push(5, "replay5")).toEqual([]); // already delivered
    expect(buf.cursor).toBe(6);
  });
});

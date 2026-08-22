import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  DebugEcho,
  DebugEchoed,
  decodeFrame,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FrameKind,
  Hello,
  negotiateVersion,
  PROTOCOL_VERSION,
  parseInbound,
  SUPPORTED_VERSIONS,
} from "../src/index.ts";

describe("version negotiation", () => {
  test("overlapping ranges pick the highest common version", () => {
    expect(negotiateVersion({ min: 1, max: 3 }, { min: 2, max: 5 })).toBe(3);
    expect(negotiateVersion(SUPPORTED_VERSIONS, SUPPORTED_VERSIONS)).toBe(PROTOCOL_VERSION);
  });

  test("disjoint ranges return null", () => {
    expect(negotiateVersion({ min: 1, max: 1 }, { min: 2, max: 3 })).toBeNull();
  });
});

describe("envelope round-trips", () => {
  test("hello create → serialize → parseInbound", () => {
    const msg = Hello.create({
      protocol: { min: 1, max: 1 },
      device_id: "dev_1",
      resume: { proj_a: 42 },
    });
    const parsed = parseInbound(JSON.stringify(msg));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.type === "hello") {
      expect(parsed.value.payload.device_id).toBe("dev_1");
      expect(parsed.value.payload.resume?.proj_a).toBe(42);
    }
  });

  test("command request carries command_id; response echoes it with duplicate flag", () => {
    const req = DebugEcho.createRequest({ text: "hi" });
    const res = DebugEcho.createOk(req.command_id, { echoed: "hi" }, { duplicate: true });
    const parsedReq = parseInbound(JSON.stringify(req));
    const parsedRes = parseInbound(JSON.stringify(res));
    expect(parsedReq.ok && parsedRes.ok).toBe(true);
    if (parsedRes.ok && parsedRes.value.type === "debug.echo.result") {
      expect(parsedRes.value.command_id).toBe(req.command_id);
      expect(parsedRes.value.payload.status).toBe("ok");
      if (parsedRes.value.payload.status === "ok") {
        expect(parsedRes.value.payload.duplicate).toBe(true);
      }
    }
  });

  test("event requires stream + seq", () => {
    const ev = DebugEchoed.create("proj_a", 7, {
      text: "x",
      command_id: DebugEcho.createRequest({ text: "x" }).command_id,
    });
    const parsed = parseInbound(JSON.stringify(ev));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.type === "debug.echoed") {
      expect(parsed.value.seq).toBe(7);
      expect(parsed.value.stream).toBe("proj_a");
    }
  });

  test("rejects malformed JSON, unknown types, and invalid payloads", () => {
    expect(parseInbound("{nope").ok).toBe(false);
    expect(
      parseInbound({ id: "x", type: "nope.nope", version: 1, ts: "now", payload: {} }).ok,
    ).toBe(false);
    const bad = {
      ...Hello.create({ protocol: { min: 1, max: 1 }, device_id: "d" }),
      payload: { device_id: 5 },
    };
    expect(parseInbound(bad).ok).toBe(false);
  });
});

describe("binary frames", () => {
  test("header is exactly 13 bytes and round-trips", () => {
    const frame = {
      kind: FrameKind.TerminalChunk,
      streamId: 42,
      seq: 7,
      payload: new Uint8Array([1, 2, 3]),
    };
    const encoded = encodeFrame(frame);
    expect(encoded.byteLength).toBe(FRAME_HEADER_BYTES + 3);
    const decoded = decodeFrame(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.kind).toBe(FrameKind.TerminalChunk);
      expect(decoded.value.streamId).toBe(42);
      expect(decoded.value.seq).toBe(7);
      expect([...decoded.value.payload]).toEqual([1, 2, 3]);
    }
  });

  test("property: any frame round-trips losslessly", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(FrameKind.FileChunk, FrameKind.TerminalChunk, FrameKind.TunnelData),
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.uint8Array({ maxLength: 4096 }),
        (kind, streamId, seq, payload) => {
          const decoded = decodeFrame(encodeFrame({ kind, streamId, seq, payload }));
          return (
            decoded.ok &&
            decoded.value.kind === kind &&
            decoded.value.streamId === streamId &&
            decoded.value.seq === seq &&
            Buffer.compare(Buffer.from(decoded.value.payload), Buffer.from(payload)) === 0
          );
        },
      ),
    );
  });

  test("rejects short buffers, bad kinds, and length mismatches", () => {
    expect(decodeFrame(new Uint8Array(5)).ok).toBe(false);
    const badKind = encodeFrame({
      kind: FrameKind.FileChunk,
      streamId: 1,
      seq: 1,
      payload: new Uint8Array(0),
    });
    badKind[0] = 250;
    expect(decodeFrame(badKind).ok).toBe(false);
    const truncated = encodeFrame({
      kind: FrameKind.FileChunk,
      streamId: 1,
      seq: 1,
      payload: new Uint8Array(10),
    }).subarray(0, 15);
    expect(decodeFrame(truncated).ok).toBe(false);
  });
});

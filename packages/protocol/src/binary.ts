import { err, ok, type Result } from "@rdc/shared";

/** 13-byte header: kind u8 | streamId u32be | seq u32be | len u32be (IMPLEMENTATION-PLAN S0.2). */
export const FRAME_HEADER_BYTES = 13;

export const FrameKind = {
  FileChunk: 1,
  TerminalChunk: 2,
  TunnelData: 3,
  /** secretstream header exchange during the secure handshake (S2) */
  SecureHeader: 4,
  /** secretstream-encrypted JSON envelope (S2) */
  Encrypted: 5,
} as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

const VALID_KINDS = new Set<number>(Object.values(FrameKind));

export interface BinaryFrame {
  kind: FrameKind;
  streamId: number;
  seq: number;
  payload: Uint8Array;
}

export function encodeFrame(frame: BinaryFrame): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, frame.kind);
  view.setUint32(1, frame.streamId);
  view.setUint32(5, frame.seq);
  view.setUint32(9, frame.payload.byteLength);
  out.set(frame.payload, FRAME_HEADER_BYTES);
  return out;
}

export function decodeFrame(data: Uint8Array): Result<BinaryFrame, Error> {
  if (data.byteLength < FRAME_HEADER_BYTES) {
    return err(new Error(`frame too short: ${data.byteLength} < ${FRAME_HEADER_BYTES}`));
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kind = view.getUint8(0);
  if (!VALID_KINDS.has(kind)) return err(new Error(`unknown frame kind: ${kind}`));
  const len = view.getUint32(9);
  if (data.byteLength !== FRAME_HEADER_BYTES + len) {
    return err(
      new Error(
        `length mismatch: header says ${len}, actual ${data.byteLength - FRAME_HEADER_BYTES}`,
      ),
    );
  }
  return ok({
    kind: kind as FrameKind,
    streamId: view.getUint32(1),
    seq: view.getUint32(5),
    payload: data.subarray(FRAME_HEADER_BYTES),
  });
}

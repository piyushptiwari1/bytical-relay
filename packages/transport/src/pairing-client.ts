import { type PairGrant, PairGrantSchema, PairRequest, parseInbound } from "@rdc/protocol";
import { type KxKeypair, openBox, toB64 } from "@rdc/security/client";
import { defaultWebSocketFactory, type WebSocketFactory } from "./websocket.ts";

export interface PairOptions {
  /** ws://host:port/pair */
  url: string;
  code: string;
  deviceName: string;
  keypair: KxKeypair;
  /** from the QR payload — authenticates the controller */
  controllerKxPub: Uint8Array;
  onPending?: (fingerprint: string) => void;
  timeoutMs?: number;
  webSocketFactory?: WebSocketFactory;
}

/**
 * Phone-side pairing flow (PLAN §20): send code + kx pub → wait for laptop
 * confirmation → receive crypto_box-sealed grant (only the controller whose
 * public key was in the QR can produce it).
 */
export function pairWithController(options: PairOptions): Promise<PairGrant> {
  const factory = options.webSocketFactory ?? defaultWebSocketFactory;
  const socket = factory(options.url);
  const dec = new TextDecoder();
  return new Promise<PairGrant>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close(4002, "pairing timeout");
      reject(new Error("pairing timed out"));
    }, options.timeoutMs ?? 90_000);
    (timer as { unref?: () => void }).unref?.();
    const fail = (cause: Error) => {
      clearTimeout(timer);
      socket.close(1000);
      reject(cause);
    };
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify(
          PairRequest.create({
            code: options.code,
            device_name: options.deviceName,
            kx_pub: toB64(options.keypair.publicKey),
          }),
        ),
      );
    });
    socket.addEventListener("error", () => fail(new Error("pairing socket error")));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const parsed = parseInbound(event.data);
      if (!parsed.ok) return;
      const msg = parsed.value;
      if (msg.type === "pair.pending") {
        options.onPending?.(msg.payload.fingerprint);
        return;
      }
      if (msg.type === "pair.reject") {
        fail(new Error(`pairing rejected: ${msg.payload.error.message}`));
        return;
      }
      if (msg.type === "pair.granted") {
        try {
          const inner = dec.decode(
            openBox(msg.payload.sealed, options.controllerKxPub, options.keypair.privateKey),
          );
          const grant = PairGrantSchema.parse(JSON.parse(inner));
          clearTimeout(timer);
          socket.close(1000, "paired");
          resolve(grant);
        } catch (cause) {
          fail(new Error(`grant verification failed: ${String(cause)}`));
        }
      }
    });
  });
}

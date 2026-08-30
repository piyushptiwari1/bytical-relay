import { type PairGrant, PairGrantSchema, PairRequest, parseInbound } from "@rdc/protocol";
import { emojiFingerprint, type KxKeypair, openBox, toB64 } from "@rdc/security/client";
import { defaultWebSocketFactory, type WebSocketFactory } from "./websocket.ts";

export interface PairOptions {
  /** ws://host:port/pair */
  url: string;
  code: string;
  deviceName: string;
  /** Stable per-install id — lets the controller update the same device on re-pair. */
  installId?: string;
  keypair: KxKeypair;
  /** from the QR payload — authenticates the controller */
  controllerKxPub: Uint8Array;
  onPending?: (fingerprint: string) => void;
  timeoutMs?: number;
  /** how long to wait for the socket to open before trying the next address */
  connectTimeoutMs?: number;
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
    const connectTimer = setTimeout(() => {
      socket.close(4001, "connect timeout");
      reject(new Error("controller unreachable"));
    }, options.connectTimeoutMs ?? 8_000);
    (connectTimer as { unref?: () => void }).unref?.();
    const fail = (cause: Error) => {
      clearTimeout(timer);
      clearTimeout(connectTimer);
      socket.close(1000);
      reject(cause);
    };
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      socket.send(
        JSON.stringify(
          PairRequest.create({
            code: options.code,
            device_name: options.deviceName,
            kx_pub: toB64(options.keypair.publicKey),
            ...(options.installId ? { install_id: options.installId } : {}),
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
        // Real SAS: compute the fingerprint locally from the QR-trusted controller
        // key + our own key; never display a string the network chose for us.
        const local = emojiFingerprint(options.controllerKxPub, options.keypair.publicKey);
        if (msg.payload.fingerprint !== local) {
          fail(new Error("fingerprint mismatch — possible interception, pairing aborted"));
          return;
        }
        options.onPending?.(local);
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
          clearTimeout(connectTimer);
          socket.close(1000, "paired");
          resolve(grant);
        } catch (cause) {
          fail(new Error(`grant verification failed: ${String(cause)}`));
        }
      }
    });
  });
}

import WebSocket from "ws";
import type { PairingCoordinator } from "./pairing-coordinator.ts";

/** Dials the relay's pairing bridge so a phone can pair from a network that
 * isolates devices (office/guest Wi-Fi). The bridged socket is handled exactly
 * like a LAN /pair connection — same code, same fingerprint ceremony, same
 * sealed grant; the relay only forwards opaque text frames. */
export function openPairingBridge(opts: {
  relayUrl: string;
  relayToken?: string;
  machineSecret?: string;
  pairingId: string;
  pairing: PairingCoordinator;
  ttlMs?: number;
}): () => void {
  const base = opts.relayUrl.replace(/\/+$/, "");
  const credential = opts.relayToken
    ? `rt=${encodeURIComponent(opts.relayToken)}`
    : `ms=${encodeURIComponent(opts.machineSecret ?? "")}`;
  const socket = new WebSocket(
    `${base}/pair-bridge?role=controller&pairing=${opts.pairingId}&${credential}`,
  );
  const adapter = {
    send: (json: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(json);
    },
    close: (code?: number, reason?: string) => {
      try {
        socket.close(code, reason);
      } catch {
        /* already closed */
      }
    },
  };
  let attached = false;
  socket.on("open", () => {
    attached = true;
    opts.pairing.attachSocket(adapter);
  });
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) opts.pairing.handlePairMessage(data.toString());
  });
  const cleanup = () => {
    clearTimeout(timer);
    if (attached) {
      attached = false;
      opts.pairing.detachSocket(adapter);
    }
  };
  socket.on("close", cleanup);
  // relay unreachable = LAN pairing still works; never fail the ceremony
  socket.on("error", cleanup);
  const timer = setTimeout(() => adapter.close(1000, "pairing bridge ttl"), opts.ttlMs ?? 180_000);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    cleanup();
    adapter.close(1000, "pairing ended");
  };
}

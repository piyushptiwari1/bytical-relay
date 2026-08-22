import {
  type PairGrant,
  PairGranted,
  PairPending,
  type PairQr,
  PairReject,
  parseInbound,
  protocolError,
} from "@rdc/protocol";
import {
  emojiFingerprint,
  fromB64,
  issueToken,
  type KxKeypair,
  PairingSession,
  type PairingState,
  sealBox,
  toB64,
} from "@rdc/security";
import { newId } from "@rdc/shared";
import type { DeviceStore } from "./device-store.ts";

export interface PairSocket {
  send(json: string): void;
  close(code?: number, reason?: string): void;
}

export interface PairingStatus {
  state: PairingState | "idle";
  fingerprint?: string;
  device_name?: string;
  granted_device_id?: string;
  expires_in_s?: number;
}

const DEFAULT_SCOPES = ["projects.read", "files.read", "events.read"];
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d — refresh rotation arrives with the relay (S7)

/** Orchestrates one pairing session: dashboard start/confirm ↔ /pair socket (PLAN §20). */
export class PairingCoordinator {
  #session: PairingSession | null = null;
  #socket: PairSocket | null = null;
  #grantedDeviceId: string | null = null;

  constructor(
    private readonly deps: {
      keys: KxKeypair;
      devices: DeviceStore;
      machineId: string;
      machineName: string;
    },
  ) {}

  start(): { code: string; expiresAt: number } {
    this.#socket?.close(1000, "pairing restarted");
    this.#socket = null;
    this.#session = new PairingSession();
    this.#grantedDeviceId = null;
    return { code: this.#session.code, expiresAt: this.#session.expiresAt };
  }

  qrPayload(addrs: string[]): PairQr {
    if (!this.#session) throw new Error("no pairing session");
    return {
      v: 1,
      addrs,
      machine_id: this.deps.machineId,
      name: this.deps.machineName,
      kx_pub: toB64(this.deps.keys.publicKey),
      code: this.#session.code,
    };
  }

  status(): PairingStatus {
    const session = this.#session;
    if (!session) return { state: "idle" };
    const pending = session.pendingDevice;
    const status: PairingStatus = {
      state: session.state(),
      expires_in_s: Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000)),
    };
    if (pending) {
      status.fingerprint = emojiFingerprint(
        this.deps.keys.publicKey,
        fromB64(pending.deviceKxPubB64),
      );
      status.device_name = pending.deviceName;
    }
    if (this.#grantedDeviceId) status.granted_device_id = this.#grantedDeviceId;
    return status;
  }

  attachSocket(socket: PairSocket): void {
    this.#socket?.close(1000, "replaced by newer connection");
    this.#socket = socket;
  }

  detachSocket(socket: PairSocket): void {
    if (this.#socket === socket) this.#socket = null;
  }

  handlePairMessage(raw: string): void {
    const socket = this.#socket;
    if (!socket) return;
    const reject = (
      code: Parameters<typeof protocolError>[0],
      message: string,
      attemptsLeft: number | null,
    ) =>
      socket.send(
        JSON.stringify(
          PairReject.create({ error: protocolError(code, message), attempts_left: attemptsLeft }),
        ),
      );

    const parsed = parseInbound(raw);
    if (!parsed.ok || parsed.value.type !== "pair.request") {
      reject("INVALID_PAYLOAD", "expected pair.request", null);
      return;
    }
    const session = this.#session;
    if (!session) {
      reject("NOT_FOUND", "no pairing in progress — start pairing on the dashboard", null);
      socket.close(1000);
      return;
    }
    const { code, device_name, kx_pub } = parsed.value.payload;
    const result = session.attempt(code, { deviceName: device_name, deviceKxPubB64: kx_pub });
    switch (result) {
      case "pending_confirm": {
        const fingerprint = emojiFingerprint(this.deps.keys.publicKey, fromB64(kx_pub));
        socket.send(JSON.stringify(PairPending.create({ fingerprint })));
        return;
      }
      case "mismatch":
        reject("FORBIDDEN", "wrong pairing code", session.attemptsLeft);
        return;
      case "locked":
        reject("FORBIDDEN", "too many attempts — restart pairing on the dashboard", 0);
        socket.close(1008, "locked");
        return;
      default:
        reject("NOT_FOUND", `pairing session is ${result}`, null);
        socket.close(1000);
    }
  }

  /** Dashboard confirmation → persist device, seal + push the grant. */
  confirm(): { device_id: string; device_name: string } | null {
    const session = this.#session;
    const pending = session?.pendingDevice;
    if (!session || !pending || !session.confirm()) return null;
    const deviceId = `dev_${newId()}`;
    const issued = issueToken(deviceId, DEFAULT_SCOPES, TOKEN_TTL_MS);
    this.deps.devices.add({
      device_id: deviceId,
      name: pending.deviceName,
      kx_pub: pending.deviceKxPubB64,
      token_hash: issued.record.token_hash,
      scopes: DEFAULT_SCOPES,
    });
    const grant: PairGrant = {
      device_id: deviceId,
      token: issued.token,
      machine_id: this.deps.machineId,
      machine_name: this.deps.machineName,
      controller_kx_pub: toB64(this.deps.keys.publicKey),
    };
    const sealed = sealBox(
      new TextEncoder().encode(JSON.stringify(grant)),
      fromB64(pending.deviceKxPubB64),
      this.deps.keys.privateKey,
    );
    this.#socket?.send(JSON.stringify(PairGranted.create({ sealed })));
    this.#socket?.close(1000, "paired");
    this.#socket = null;
    this.#grantedDeviceId = deviceId;
    return { device_id: deviceId, device_name: pending.deviceName };
  }

  cancel(): void {
    this.#session?.cancel();
    this.#socket?.close(1000, "cancelled");
    this.#socket = null;
  }
}

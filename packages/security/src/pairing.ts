import { randomInt } from "node:crypto";

/**
 * One-time pairing session state machine (PLAN §20): 60s TTL, single use,
 * 5-attempt lockout. One active session at a time (coordinator enforces).
 */

export type PairingState =
  | "waiting"
  | "pending_confirm"
  | "granted"
  | "expired"
  | "cancelled"
  | "locked";

// no 0/O/1/I lookalikes
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_ATTEMPTS = 5;

export function generatePairingCode(length = 8): string {
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export interface PendingDevice {
  deviceName: string;
  deviceKxPubB64: string;
  installId?: string;
}

export class PairingSession {
  readonly code: string;
  readonly expiresAt: number;
  #state: PairingState = "waiting";
  #attempts = 0;
  #pending: PendingDevice | null = null;

  constructor(now = Date.now(), ttlMs = 60_000, code = generatePairingCode()) {
    this.code = code;
    this.expiresAt = now + ttlMs;
  }

  state(now = Date.now()): PairingState {
    if (this.#state === "waiting" && now >= this.expiresAt) this.#state = "expired";
    return this.#state;
  }

  get pendingDevice(): PendingDevice | null {
    return this.#pending;
  }

  /** Code check from an untrusted /pair connection. */
  attempt(code: string, device: PendingDevice, now = Date.now()): PairingState | "mismatch" {
    const current = this.state(now);
    if (current !== "waiting") return current;
    if (code !== this.code) {
      this.#attempts += 1;
      if (this.#attempts >= MAX_ATTEMPTS) {
        this.#state = "locked";
        return "locked";
      }
      return "mismatch";
    }
    this.#pending = device;
    this.#state = "pending_confirm";
    return "pending_confirm";
  }

  get attemptsLeft(): number {
    return Math.max(0, MAX_ATTEMPTS - this.#attempts);
  }

  /** Laptop-side confirmation (dashboard button). */
  confirm(now = Date.now()): boolean {
    if (this.state(now) !== "pending_confirm") return false;
    this.#state = "granted";
    return true;
  }

  cancel(): void {
    if (this.#state === "waiting" || this.#state === "pending_confirm") this.#state = "cancelled";
  }
}

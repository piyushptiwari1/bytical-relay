import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";

/**
 * E2EE primitives (PLAN §36) on audited pure-JS @noble crypto — no WASM, no
 * native code, so the identical implementation runs in Node and React Native
 * (Hermes has no WebAssembly, which rules libsodium out on the phone).
 *
 * Construction ("rdc/e2ee/v2"):
 *   - session keys: X25519 shared secret → BLAKE2b-512(q ‖ client_pk ‖ server_pk)
 *     split into rx/tx halves (the libsodium crypto_kx layout)
 *   - channel: per-connection random 24-byte headers; per-direction message key
 *     = keyed BLAKE2b(context ‖ header); each message = nonce(24) ‖ XChaCha20-
 *     Poly1305 ciphertext, nonce = LE64 counter ‖ 16 random bytes; receivers
 *     enforce strictly-increasing counters (replay/reorder rejection)
 */

export interface KxKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export const generateKxKeypair = (): KxKeypair => {
  const privateKey = x25519.utils.randomSecretKey();
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
};

// ── base64 (no Buffer/btoa — Hermes-safe) ────────────────────────────────────
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function toB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function fromB64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? (B64_LOOKUP[code] as number) : -1;
    if (value < 0) throw new Error("invalid base64 input");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

// ── crypto_kx-style session keys ─────────────────────────────────────────────
export type ChannelRole = "client" | "server";

function kxSessionKeys(
  role: ChannelRole,
  mine: KxKeypair,
  peerPublicKey: Uint8Array,
): { rx: Uint8Array; tx: Uint8Array } {
  const isClient = role === "client";
  const clientPk = isClient ? mine.publicKey : peerPublicKey;
  const serverPk = isClient ? peerPublicKey : mine.publicKey;
  const q = x25519.getSharedSecret(mine.privateKey, peerPublicKey);
  const h = blake2b(concatBytes(q, clientPk, serverPk), { dkLen: 64 });
  const first = h.slice(0, 32);
  const second = h.slice(32, 64);
  return isClient ? { rx: first, tx: second } : { rx: second, tx: first };
}

const CHANNEL_CONTEXT = new TextEncoder().encode("rdc/e2ee/v2");
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const COUNTER_BYTES = 8;

function writeCounterLE(target: Uint8Array, counter: number): void {
  let lo = counter >>> 0;
  let hi = Math.floor(counter / 0x1_0000_0000);
  for (let i = 0; i < 4; i++) {
    target[i] = lo & 0xff;
    lo >>>= 8;
  }
  for (let i = 4; i < 8; i++) {
    target[i] = hi & 0xff;
    hi = Math.floor(hi / 256);
  }
}

function readCounterLE(source: Uint8Array): number {
  let value = 0;
  for (let i = COUNTER_BYTES - 1; i >= 0; i--) value = value * 256 + (source[i] as number);
  return value;
}

/**
 * Bidirectional encrypted channel. Flow:
 *   1. both sides derive session keys via X25519 kx (role decides orientation)
 *   2. each side sends `createHeader()` to the peer (SecureHeader frame)
 *   3. each side calls `acceptHeader(peerHeader)` → `ready`
 *   4. `encrypt()`/`decrypt()` wrap every protocol envelope
 * Fresh headers per connection re-randomize message keys even though the
 * kx keypairs are static (ephemeral-key upgrade tracked for the relay phase).
 */
export class SecureChannel {
  #txKey: Uint8Array;
  #rxKey: Uint8Array;
  #txMsgKey: Uint8Array | null = null;
  #rxMsgKey: Uint8Array | null = null;
  #txCounter = 0;
  #rxCounter = 0;

  constructor(role: ChannelRole, mine: KxKeypair, peerPublicKey: Uint8Array) {
    const keys = kxSessionKeys(role, mine, peerPublicKey);
    this.#rxKey = keys.rx;
    this.#txKey = keys.tx;
  }

  createHeader(): Uint8Array {
    const header = randomBytes(NONCE_BYTES);
    this.#txMsgKey = blake2b(concatBytes(CHANNEL_CONTEXT, header), {
      key: this.#txKey,
      dkLen: 32,
    });
    this.#txCounter = 0;
    return header;
  }

  acceptHeader(header: Uint8Array): void {
    this.#rxMsgKey = blake2b(concatBytes(CHANNEL_CONTEXT, header), {
      key: this.#rxKey,
      dkLen: 32,
    });
    this.#rxCounter = 0;
  }

  get ready(): boolean {
    return this.#txMsgKey !== null && this.#rxMsgKey !== null;
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (!this.#txMsgKey) throw new Error("secure channel: createHeader() not called");
    this.#txCounter += 1;
    const nonce = new Uint8Array(NONCE_BYTES);
    writeCounterLE(nonce, this.#txCounter);
    nonce.set(randomBytes(NONCE_BYTES - COUNTER_BYTES), COUNTER_BYTES);
    const ciphertext = xchacha20poly1305(this.#txMsgKey, nonce).encrypt(plaintext);
    return concatBytes(nonce, ciphertext);
  }

  /** Throws on tampered, replayed, or reordered ciphertext. */
  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (!this.#rxMsgKey) throw new Error("secure channel: peer header not accepted");
    if (ciphertext.length < NONCE_BYTES + TAG_BYTES) {
      throw new Error("secure channel: ciphertext too short");
    }
    const nonce = ciphertext.subarray(0, NONCE_BYTES);
    const counter = readCounterLE(nonce);
    if (counter <= this.#rxCounter) {
      throw new Error("secure channel: replayed or reordered message");
    }
    const message = xchacha20poly1305(this.#rxMsgKey, nonce).decrypt(
      ciphertext.subarray(NONCE_BYTES),
    );
    this.#rxCounter = counter;
    return message;
  }
}

// ── one-shot authenticated box (pairing grant) ───────────────────────────────
function boxKey(sharedSecret: Uint8Array): Uint8Array {
  return blake2b(sharedSecret, { dkLen: 32 });
}

/** Authenticated one-shot box for the pairing grant (server → freshly-paired device). */
export function sealBox(
  payload: Uint8Array,
  recipientPub: Uint8Array,
  senderPriv: Uint8Array,
): string {
  const key = boxKey(x25519.getSharedSecret(senderPriv, recipientPub));
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(payload);
  return toB64(concatBytes(nonce, ciphertext));
}

export function openBox(
  sealed: string,
  senderPub: Uint8Array,
  recipientPriv: Uint8Array,
): Uint8Array {
  const bytes = fromB64(sealed);
  if (bytes.length < NONCE_BYTES + TAG_BYTES) throw new Error("sealed box too short");
  const key = boxKey(x25519.getSharedSecret(recipientPriv, senderPub));
  return xchacha20poly1305(key, bytes.subarray(0, NONCE_BYTES)).decrypt(
    bytes.subarray(NONCE_BYTES),
  );
}

const FINGERPRINT_EMOJI = [
  "🦊",
  "🐙",
  "🦉",
  "🐢",
  "🐝",
  "🦁",
  "🐬",
  "🦋",
  "🌵",
  "🌊",
  "🔥",
  "⭐",
  "🌙",
  "🍀",
  "🍉",
  "🎲",
  "🎈",
  "🎸",
  "🚀",
  "⚓",
  "🔑",
  "🧭",
  "🧩",
  "🎯",
  "🥝",
  "🦄",
  "🐳",
  "🎁",
  "🔔",
  "🍄",
  "🌈",
  "🛶",
] as const;

/** 4-emoji verification fingerprint of the key pairing (server pub ‖ client pub). */
export function emojiFingerprint(serverPub: Uint8Array, clientPub: Uint8Array): string {
  const digest = blake2b(concatBytes(serverPub, clientPub), { dkLen: 8 });
  return [0, 1, 2, 3]
    .map((i) => FINGERPRINT_EMOJI[(digest[i] as number) % FINGERPRINT_EMOJI.length])
    .join(" ");
}

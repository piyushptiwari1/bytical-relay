import { createRequire } from "node:module";
import type { StateAddress } from "libsodium-wrappers";

type SodiumModule = typeof import("libsodium-wrappers");

/**
 * E2EE primitives (PLAN §36): X25519 crypto_kx session keys + XChaCha20-Poly1305
 * secretstream. libsodium-wrappers' ESM dist is broken under Node resolution,
 * so the CJS build is loaded via createRequire; the phone swaps this module for
 * react-native-libsodium behind the same API surface (S2b).
 *
 * Call `initSodium()` once at process start; everything after is synchronous.
 */

let sodium: SodiumModule | null = null;

export async function initSodium(): Promise<void> {
  const mod = createRequire(import.meta.url)("libsodium-wrappers") as SodiumModule;
  await mod.ready;
  sodium = mod;
}

function s(): SodiumModule {
  if (!sodium) throw new Error("initSodium() must be awaited before using crypto");
  return sodium;
}

export interface KxKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export const generateKxKeypair = (): KxKeypair => {
  const kp = s().crypto_kx_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
};

export const toB64 = (bytes: Uint8Array): string =>
  s().to_base64(bytes, s().base64_variants.ORIGINAL);
export const fromB64 = (text: string): Uint8Array =>
  s().from_base64(text, s().base64_variants.ORIGINAL);

export type ChannelRole = "client" | "server";

/**
 * Bidirectional secretstream channel. Flow:
 *   1. both sides derive session keys via crypto_kx (role decides key orientation)
 *   2. each side sends `createHeader()` to the peer (SecureHeader frame)
 *   3. each side calls `acceptHeader(peerHeader)` → `ready`
 *   4. `encrypt()`/`decrypt()` wrap every protocol envelope
 * Fresh headers per connection re-randomize stream keys even though the
 * kx keypairs are static (ephemeral-key upgrade tracked for the relay phase).
 */
export class SecureChannel {
  #txKey: Uint8Array;
  #rxKey: Uint8Array;
  #pushState: StateAddress | null = null;
  #pullState: StateAddress | null = null;

  constructor(role: ChannelRole, mine: KxKeypair, peerPublicKey: Uint8Array) {
    const keys =
      role === "client"
        ? s().crypto_kx_client_session_keys(mine.publicKey, mine.privateKey, peerPublicKey)
        : s().crypto_kx_server_session_keys(mine.publicKey, mine.privateKey, peerPublicKey);
    this.#rxKey = keys.sharedRx;
    this.#txKey = keys.sharedTx;
  }

  createHeader(): Uint8Array {
    const { state, header } = s().crypto_secretstream_xchacha20poly1305_init_push(this.#txKey);
    this.#pushState = state;
    return header;
  }

  acceptHeader(header: Uint8Array): void {
    this.#pullState = s().crypto_secretstream_xchacha20poly1305_init_pull(header, this.#rxKey);
  }

  get ready(): boolean {
    return this.#pushState !== null && this.#pullState !== null;
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (!this.#pushState) throw new Error("secure channel: createHeader() not called");
    return s().crypto_secretstream_xchacha20poly1305_push(
      this.#pushState,
      plaintext,
      null,
      s().crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
  }

  /** Throws on tampered/replayed ciphertext. */
  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (!this.#pullState) throw new Error("secure channel: peer header not accepted");
    const result = s().crypto_secretstream_xchacha20poly1305_pull(
      this.#pullState,
      ciphertext,
      null,
    );
    if (!result) throw new Error("secure channel: decryption failed");
    return result.message;
  }
}

/** Authenticated one-shot box for the pairing grant (server → freshly-paired device). */
export function sealBox(
  payload: Uint8Array,
  recipientPub: Uint8Array,
  senderPriv: Uint8Array,
): string {
  const nonce = s().randombytes_buf(s().crypto_box_NONCEBYTES);
  const box = s().crypto_box_easy(payload, nonce, recipientPub, senderPriv);
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce, 0);
  out.set(box, nonce.length);
  return toB64(out);
}

export function openBox(
  sealed: string,
  senderPub: Uint8Array,
  recipientPriv: Uint8Array,
): Uint8Array {
  const bytes = fromB64(sealed);
  const nonceLen = s().crypto_box_NONCEBYTES;
  const nonce = bytes.subarray(0, nonceLen);
  const box = bytes.subarray(nonceLen);
  return s().crypto_box_open_easy(box, nonce, senderPub, recipientPriv);
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
  const joined = new Uint8Array(serverPub.length + clientPub.length);
  joined.set(serverPub, 0);
  joined.set(clientPub, serverPub.length);
  const digest = s().crypto_generichash(8, joined);
  return [0, 1, 2, 3]
    .map((i) => FINGERPRINT_EMOJI[(digest[i] as number) % FINGERPRINT_EMOJI.length])
    .join(" ");
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fromB64, generateKxKeypair, type KxKeypair, toB64 } from "@rdc/security";

/**
 * Controller X25519 identity (requires initSodium() first).
 * TODO(S7): DPAPI-wrap before public distribution (PLAN §19).
 */
export function loadOrCreateKeys(dir: string): KxKeypair {
  const file = path.join(dir, "keys.json");
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as { kx_pub: string; kx_priv: string };
    return { publicKey: fromB64(stored.kx_pub), privateKey: fromB64(stored.kx_priv) };
  }
  const keypair = generateKxKeypair();
  writeFileSync(
    file,
    `${JSON.stringify({ kx_pub: toB64(keypair.publicKey), kx_priv: toB64(keypair.privateKey) }, null, 2)}\n`,
    "utf8",
  );
  return keypair;
}

import { initSodiumFrom, type SodiumModule } from "@rdc/security/client";
import sodium from "libsodium-wrappers";

let ready: Promise<void> | null = null;

/** Idempotent; awaited once in the root layout before any crypto use. */
export function initCrypto(): Promise<void> {
  ready ??= initSodiumFrom(sodium as unknown as SodiumModule);
  return ready;
}

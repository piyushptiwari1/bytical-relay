import { createRequire } from "node:module";
import { initSodiumFrom, type SodiumModule } from "./e2ee.ts";

/**
 * Node-only sodium loader: libsodium-wrappers' ESM dist is broken under Node
 * module resolution, so the CJS build is loaded via createRequire.
 */
export async function initSodium(): Promise<void> {
  const mod = createRequire(import.meta.url)("libsodium-wrappers") as SodiumModule;
  await initSodiumFrom(mod);
}

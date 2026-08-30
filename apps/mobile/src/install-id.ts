import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const KEY = "rdc_install_id";
let cached: string | null = null;

/**
 * Stable per-install identity. Minted once, kept in SecureStore, sent with
 * every pairing so the controller updates the SAME device record on re-pair
 * (one row per physical phone). A reinstall mints a new id — that is a
 * genuinely new crypto identity, like re-linking a messaging app.
 */
export async function getInstallId(): Promise<string> {
  if (cached) return cached;
  try {
    const existing = await SecureStore.getItemAsync(KEY);
    if (existing) {
      cached = existing;
      return existing;
    }
    const fresh = `inst_${randomUUID()}`;
    await SecureStore.setItemAsync(KEY, fresh);
    cached = fresh;
    return fresh;
  } catch {
    // SecureStore unavailable (rare) — session-stable fallback still beats duplicates.
    cached = cached ?? `inst_${randomUUID()}`;
    return cached;
  }
}

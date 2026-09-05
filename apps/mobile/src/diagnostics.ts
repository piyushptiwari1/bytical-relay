import Constants from "expo-constants";
import { Platform } from "react-native";

const ENDPOINT = "https://ws.relay.bytical.ai/a/collect";
const recent = new Map<string, number>();

/** Failure breadcrumbs to our own analytics — code + human reason only,
 * never prompts, file contents, or tokens. Deduped for 5 minutes. */
export function reportDiag(code: string, detail: string): void {
  try {
    const key = `${code}:${detail.slice(0, 80)}`;
    const now = Date.now();
    const last = recent.get(key);
    if (last && now - last < 300_000) return;
    recent.set(key, now);
    const version = Constants.expoConfig?.version ?? "?";
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "diag",
        path: `mobile/${code}`,
        detail: `${version} ${Platform.OS} · ${detail}`.slice(0, 380),
      }),
    }).catch(() => {});
  } catch {
    /* diagnostics must never break the app */
  }
}

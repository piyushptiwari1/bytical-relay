import { isNewerVersion } from "@rdc/shared";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

export const RELEASE_PAGE_URL = "https://relay.bytical.ai/download";
const RELEASES_API_URL =
  "https://api.github.com/repos/piyushptiwari1/bytical-relay/releases/latest";
const LAST_CHECK_KEY = "rdc_update_last_check";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AvailableUpdate {
  version: string;
  url: string;
}

/** Sideload distribution has no store to announce updates — ask the public
 * releases API (unauthenticated, throttled to every 6h, silent on failure). */
export async function checkForUpdate(now = Date.now()): Promise<AvailableUpdate | null> {
  const current = Constants.expoConfig?.version;
  if (!current) return null;
  try {
    const last = Number((await SecureStore.getItemAsync(LAST_CHECK_KEY)) ?? 0);
    if (last && now - last < CHECK_INTERVAL_MS) return null;
    await SecureStore.setItemAsync(LAST_CHECK_KEY, String(now));
    const release = await fetchLatestRelease();
    if (release && isNewerVersion(current, release.tag)) {
      // evergreen redirect → one-tap APK download, always the newest build
      return { version: release.tag.replace(/^v/, ""), url: RELEASE_PAGE_URL };
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchLatestRelease(): Promise<{ tag: string; url: string } | null> {
  const response = await fetch(RELEASES_API_URL, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
  if (typeof body.tag_name !== "string") return null;
  return {
    tag: body.tag_name,
    url: typeof body.html_url === "string" ? body.html_url : RELEASE_PAGE_URL,
  };
}

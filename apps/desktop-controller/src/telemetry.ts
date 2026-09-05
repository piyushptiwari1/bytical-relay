/** Failure breadcrumbs to our own analytics service — code + reason only,
 * never file contents, prompts, or tokens. RDC_NO_TELEMETRY=1 disables. */
const ENDPOINT = "https://ws.relay.bytical.ai/a/collect";
const recent = new Map<string, number>();

export function diag(code: string, detail: string): void {
  if (process.env.RDC_NO_TELEMETRY === "1") return;
  try {
    const key = `${code}:${detail.slice(0, 80)}`;
    const now = Date.now();
    const last = recent.get(key);
    if (last && now - last < 300_000) return;
    recent.set(key, now);
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "diag",
        path: `controller/${code}`,
        detail:
          `${process.platform}/${process.arch} node${process.versions.node} · ${detail}`.slice(
            0,
            380,
          ),
      }),
    }).catch(() => {});
  } catch {
    /* telemetry must never break the controller */
  }
}

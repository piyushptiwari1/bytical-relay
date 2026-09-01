import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildAnalytics, deviceClass } from "../src/analytics.ts";

const TOKEN = "analytics-test-token-0123456789";

describe("rdc-analytics service", () => {
  let app: ReturnType<typeof buildAnalytics>;
  let base: string;

  beforeAll(async () => {
    app = buildAnalytics({
      token: TOKEN,
      geoLookup: false,
      publicOrigins: ["https://relay.bytical.ai"],
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
  });

  test("device classing is sane", () => {
    expect(deviceClass("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("mobile");
    expect(deviceClass("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("desktop");
    expect(deviceClass("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("bot");
    expect(deviceClass(undefined)).toBe("unknown");
  });

  test("public collect: accepts pageview/download, rejects junk kinds", async () => {
    const view = await fetch(`${base}/collect`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "test-desktop" },
      body: JSON.stringify({
        kind: "pageview",
        path: "/",
        referrer: "https://news.ycombinator.com",
      }),
    });
    expect(view.status).toBe(204);

    const download = await fetch(`${base}/collect`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "test-desktop" },
      body: JSON.stringify({ kind: "download", path: "/", detail: "android-apk" }),
    });
    expect(download.status).toBe(204);

    const junk = await fetch(`${base}/collect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "sql_injection" }),
    });
    expect(junk.status).toBe(400);
  });

  test("stats requires token; aggregates reflect collected hits", async () => {
    expect((await fetch(`${base}/stats`)).status).toBe(401);
    const stats = await fetch(`${base}/stats`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(stats.status).toBe(200);
    const body = (await stats.json()) as {
      totals: { pageviews: number; downloads: number };
      downloads: Array<{ detail: string; n: number }>;
      by_referrer: Array<{ referrer: string; n: number }>;
    };
    expect(body.totals.pageviews).toBe(1);
    expect(body.totals.downloads).toBe(1);
    expect(body.downloads[0]).toMatchObject({ detail: "android-apk", n: 1 });
    expect(body.by_referrer[0]?.referrer).toContain("ycombinator");
  });

  test("ingest requires token; platform kinds recorded", async () => {
    expect(
      (
        await fetch(`${base}/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "platform_up" }),
        })
      ).status,
    ).toBe(401);
    const ok = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ kind: "platform_up", detail: "controller boot" }),
    });
    expect(ok.status).toBe(200);
  });

  test("public feed: aggregated only, no referrers/paths/visitors, CORS-limited", async () => {
    const anonymous = await fetch(`${base}/public`, {
      headers: { origin: "https://relay.bytical.ai" },
    });
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("access-control-allow-origin")).toBe("https://relay.bytical.ai");
    const body = (await anonymous.json()) as Record<string, unknown>;
    expect(body.totals).toBeDefined();
    expect(body.per_day).toBeDefined();
    expect(JSON.stringify(body)).not.toContain("ycombinator"); // no referrers leak
    expect(JSON.stringify(body)).not.toContain("visitorHash");

    const foreign = await fetch(`${base}/public`, { headers: { origin: "https://evil.example" } });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("feedback: validates, stores, aggregates into owner inbox + public rating", async () => {
    // isolated instance: own db, uncached /public (vitest retry must not see prior data)
    const fb = buildAnalytics({ token: TOKEN, geoLookup: false, publicCacheMs: 0 });
    await fb.listen({ port: 0, host: "127.0.0.1" });
    const fbase = `http://127.0.0.1:${(fb.server.address() as AddressInfo).port}`;
    try {
      // review without rating rejected
      const noRating = await fetch(`${fbase}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "review", message: "great" }),
      });
      expect(noRating.status).toBe(400);
      // junk kind rejected
      expect(
        (
          await fetch(`${fbase}/feedback`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: "spam", message: "x" }),
          })
        ).status,
      ).toBe(400);

      const review = await fetch(`${fbase}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "test-phone android mobile" },
        body: JSON.stringify({
          kind: "review",
          rating: 5,
          message: "Relay saved my evening — approved an agent plan from the couch.",
          surface: "android",
          version: "0.1.2",
        }),
      });
      expect(review.status).toBe(201);
      const bug = await fetch(`${fbase}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bug",
          message: "QR scanner slow on cold start",
          surface: "android",
          contact: "user@example.com",
        }),
      });
      expect(bug.status).toBe(201);

      // owner inbox requires token
      expect((await fetch(`${fbase}/feedback`)).status).toBe(401);
      const inbox = (await (
        await fetch(`${fbase}/feedback`, { headers: { authorization: `Bearer ${TOKEN}` } })
      ).json()) as {
        rating: { avg: number; n: number };
        by_kind: Array<{ kind: string; n: number }>;
        by_surface: Array<{ surface: string; n: number }>;
        items: Array<{ kind: string; message: string; contact: string | null; device: string }>;
      };
      expect(inbox.rating).toMatchObject({ avg: 5, n: 1 });
      expect(inbox.by_surface[0]).toMatchObject({ surface: "android", n: 2 });
      expect(inbox.items).toHaveLength(2);
      expect(inbox.items[1]?.device).toBe("mobile");
      expect(inbox.items[0]?.contact).toBe("user@example.com");

      // public feed exposes ONLY the aggregate score, never messages/contacts
      const pub = (await (await fetch(`${fbase}/public`)).json()) as Record<string, unknown>;
      expect(pub.rating).toMatchObject({ avg: 5, n: 1 });
      expect(JSON.stringify(pub)).not.toContain("example.com");
      expect(JSON.stringify(pub)).not.toContain("couch");
    } finally {
      await fb.close();
    }
  });
});

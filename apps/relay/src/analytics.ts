import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

/**
 * rdc-analytics: first-party, privacy-first product analytics for Relay by
 * Bytical. No third-party trackers, no cookies, no raw IPs stored. Browsers
 * and apps post to the public /collect endpoint (rate-limited, enriched
 * server-side); the controller posts to the token-gated /ingest endpoint.
 */

export interface AnalyticsOptions {
  token: string;
  dbPath?: string;
  /** origins allowed to POST /collect and GET /public from a browser */
  publicOrigins?: string[];
  /** local relay healthz to report service status on /public */
  relayHealthUrl?: string;
  /** disable external geo lookups in tests */
  geoLookup?: boolean;
  /** /public cache TTL (default 60s; 0 in tests) */
  publicCacheMs?: number;
}

const PUBLIC_KINDS = new Set(["pageview", "download", "app_launch", "app_pair", "diag"]);
const ALL_KINDS = new Set([...PUBLIC_KINDS, "event", "platform_up"]);
const FEEDBACK_KINDS = new Set(["review", "feature", "update_request", "bug"]);
const FEEDBACK_SURFACES = new Set(["website", "android", "ios", "vscode", "controller", "other"]);
const MAX_BODY = 4 * 1024;

const clean = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;

function tokenOk(expected: string, header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

/** UA → coarse device class; own parsing, no dependency. */
export function deviceClass(userAgent: string | undefined): string {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return "unknown";
  if (/bot|crawl|spider|slurp|bingpreview|facebookexternalhit|lighthouse/.test(ua)) return "bot";
  if (/ipad|tablet|(android(?!.*mobile))/.test(ua)) return "tablet";
  if (/mobi|iphone|android/.test(ua)) return "mobile";
  return "desktop";
}

function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? req.ip;
  }
  return req.ip;
}

/** In-memory per-IP token bucket: 30 events/min is plenty for a human. */
class RateLimiter {
  #buckets = new Map<string, { tokens: number; at: number }>();

  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.#buckets.get(key) ?? { tokens: 30, at: now };
    bucket.tokens = Math.min(30, bucket.tokens + ((now - bucket.at) / 60_000) * 30);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.#buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    if (this.#buckets.size > 10_000) this.#buckets.clear();
    return true;
  }
}

/** Own geo enrichment: cached country lookups, fail-open. Swappable for MaxMind. */
class GeoCache {
  #cache = new Map<string, { country: string | null; region: string | null }>();
  readonly #enabled: boolean;

  constructor(enabled: boolean) {
    this.#enabled = enabled;
  }

  async lookup(ip: string): Promise<{ country: string | null; region: string | null }> {
    if (!this.#enabled || !ip || ip.startsWith("127.") || ip === "::1") {
      return { country: null, region: null };
    }
    const cached = this.#cache.get(ip);
    if (cached) return cached;
    try {
      const response = await fetch(
        `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,regionName`,
        { signal: AbortSignal.timeout(1500) },
      );
      const data = (await response.json()) as {
        status?: string;
        countryCode?: string;
        regionName?: string;
      };
      const result =
        data.status === "success"
          ? { country: data.countryCode ?? null, region: data.regionName ?? null }
          : { country: null, region: null };
      if (this.#cache.size > 50_000) this.#cache.clear();
      this.#cache.set(ip, result);
      return result;
    } catch {
      return { country: null, region: null };
    }
  }
}

export function buildAnalytics(options: AnalyticsOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY });
  const db = new DatabaseSync(options.dbPath ?? ":memory:");
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT,
      referrer TEXT,
      country TEXT,
      region TEXT,
      device TEXT,
      visitor TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS hits_by_day ON hits (day, kind);
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      rating INTEGER,
      message TEXT NOT NULL,
      contact TEXT,
      surface TEXT NOT NULL,
      version TEXT,
      country TEXT,
      device TEXT,
      visitor TEXT
    );
    CREATE INDEX IF NOT EXISTS feedback_by_day ON feedback (day, kind);
  `);

  const limiter = new RateLimiter();
  const geo = new GeoCache(options.geoLookup !== false);
  const origins = options.publicOrigins ?? [
    "https://relay.bytical.ai",
    "https://relay-bytical.vercel.app",
  ];

  // daily rotating salt → visitor hashes are unlinkable across days
  let saltDay = "";
  let salt = "";
  const visitorHash = (ip: string, ua: string, day: string): string => {
    if (saltDay !== day) {
      saltDay = day;
      salt = randomBytes(16).toString("hex");
    }
    return createHash("sha256").update(`${salt}:${ip}:${ua}`).digest("hex").slice(0, 24);
  };

  const corsHeaders = (req: FastifyRequest, reply: { header: (k: string, v: string) => void }) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-methods", "POST, GET, OPTIONS");
      reply.header("access-control-allow-headers", "content-type");
    }
  };

  app.options("/collect", async (req, reply) => {
    corsHeaders(req, reply);
    return reply.code(204).send();
  });

  app.options("/feedback", async (req, reply) => {
    corsHeaders(req, reply);
    return reply.code(204).send();
  });

  app.get("/healthz", async () => ({ ok: true, service: "rdc-analytics" }));

  const insert = db.prepare(
    `INSERT INTO hits (ts, day, kind, path, referrer, country, region, device, visitor, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /** Public first-party beacon: site pageviews/downloads, app lifecycle. */
  app.post("/collect", async (req, reply) => {
    corsHeaders(req, reply);
    const ip = clientIp(req);
    if (!limiter.allow(ip)) return reply.code(429).send({ ok: false });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = typeof body.kind === "string" && PUBLIC_KINDS.has(body.kind) ? body.kind : null;
    if (!kind) return reply.code(400).send({ ok: false });
    const ua = req.headers["user-agent"];
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const { country, region } = await geo.lookup(ip);
    insert.run(
      now.toISOString(),
      day,
      kind,
      clean(body.path),
      clean(body.referrer),
      country,
      region,
      deviceClass(typeof ua === "string" ? ua : undefined),
      visitorHash(ip, String(ua ?? ""), day),
      // diag = failure breadcrumbs from the field — allow a longer human reason
      clean(body.detail, kind === "diag" ? 400 : undefined),
    );
    return reply.code(204).send();
  });

  /** Owner-only field diagnostics feed — newest first, error breadcrumbs only. */
  app.get("/diag", async (req, reply) => {
    if (!tokenOk(options.token, req.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      generated_at: new Date().toISOString(),
      items: db
        .prepare(
          "SELECT ts, path AS source, device, country, detail FROM hits WHERE kind = 'diag' ORDER BY ts DESC LIMIT 200",
        )
        .all(),
    };
  });

  /** Token-gated ingest for the controller (platform lifecycle). */
  app.post("/ingest", async (req, reply) => {
    if (!tokenOk(options.token, req.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = typeof body.kind === "string" && ALL_KINDS.has(body.kind) ? body.kind : "event";
    const now = new Date();
    insert.run(
      now.toISOString(),
      now.toISOString().slice(0, 10),
      kind,
      clean(body.path),
      clean(body.referrer),
      clean(body.country, 8),
      clean(body.region, 64),
      clean(body.device, 16),
      null,
      clean(body.detail),
    );
    return { ok: true };
  });

  /** Owner stats: everything, token-gated (feeds the /data console). */
  app.get("/stats", async (req, reply) => {
    if (!tokenOk(options.token, req.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
    const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    return {
      generated_at: new Date().toISOString(),
      totals: {
        pageviews: one("SELECT COUNT(*) n FROM hits WHERE kind = 'pageview'"),
        downloads: one("SELECT COUNT(*) n FROM hits WHERE kind = 'download'"),
        app_launches: one("SELECT COUNT(*) n FROM hits WHERE kind = 'app_launch'"),
        visitors_today: one(
          `SELECT COUNT(DISTINCT visitor) n FROM hits
           WHERE day = strftime('%Y-%m-%d', 'now') AND visitor IS NOT NULL`,
        ),
      },
      per_day: all(
        `SELECT day, SUM(kind = 'pageview') views, COUNT(DISTINCT visitor) visitors,
                SUM(kind = 'download') downloads, SUM(kind = 'app_launch') app_launches
         FROM hits WHERE day >= date('now', '-30 days') GROUP BY day ORDER BY day`,
      ),
      by_path: all(
        `SELECT path, COUNT(*) n FROM hits WHERE kind = 'pageview' AND path IS NOT NULL
         GROUP BY path ORDER BY n DESC LIMIT 10`,
      ),
      by_referrer: all(
        `SELECT referrer, COUNT(*) n FROM hits WHERE referrer IS NOT NULL AND referrer != ''
         GROUP BY referrer ORDER BY n DESC LIMIT 10`,
      ),
      by_country: all(
        `SELECT country, COUNT(*) n FROM hits WHERE country IS NOT NULL
         GROUP BY country ORDER BY n DESC LIMIT 12`,
      ),
      by_device: all(
        `SELECT device, COUNT(*) n FROM hits WHERE device IS NOT NULL
         GROUP BY device ORDER BY n DESC`,
      ),
      downloads: all(
        `SELECT detail, COUNT(*) n FROM hits WHERE kind = 'download'
         GROUP BY detail ORDER BY n DESC LIMIT 8`,
      ),
      platform: all(
        `SELECT kind, COUNT(*) n FROM hits WHERE kind IN ('app_launch','app_pair','platform_up')
         GROUP BY kind ORDER BY n DESC`,
      ),
    };
  });

  const insertFeedback = db.prepare(
    `INSERT INTO feedback (ts, day, kind, rating, message, contact, surface, version, country, device, visitor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /** Public feedback intake: reviews, feature asks, update requests, bugs —
   * from every surface (website, apps, extension, controller). */
  app.post("/feedback", async (req, reply) => {
    corsHeaders(req, reply);
    const ip = clientIp(req);
    if (!limiter.allow(ip)) return reply.code(429).send({ ok: false });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = typeof body.kind === "string" && FEEDBACK_KINDS.has(body.kind) ? body.kind : null;
    const message = clean(body.message, 2000);
    if (!kind || !message)
      return reply.code(400).send({ ok: false, error: "kind and message required" });
    const rating =
      typeof body.rating === "number" && body.rating >= 1 && body.rating <= 5
        ? Math.round(body.rating)
        : null;
    if (kind === "review" && rating === null)
      return reply.code(400).send({ ok: false, error: "reviews need a 1-5 rating" });
    const surface =
      typeof body.surface === "string" && FEEDBACK_SURFACES.has(body.surface)
        ? body.surface
        : "other";
    const ua = req.headers["user-agent"];
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const { country } = await geo.lookup(ip);
    insertFeedback.run(
      now.toISOString(),
      day,
      kind,
      rating,
      message,
      clean(body.contact),
      surface,
      clean(body.version, 40),
      country,
      deviceClass(typeof ua === "string" ? ua : undefined),
      visitorHash(ip, String(ua ?? ""), day),
    );
    return reply.code(201).send({ ok: true });
  });

  /** Owner feedback inbox: rows + aggregates (feeds the /data console). */
  app.get("/feedback", async (req, reply) => {
    if (!tokenOk(options.token, req.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
    return {
      generated_at: new Date().toISOString(),
      rating: db
        .prepare(
          "SELECT ROUND(AVG(rating), 2) avg, COUNT(*) n FROM feedback WHERE rating IS NOT NULL",
        )
        .get(),
      by_kind: all("SELECT kind, COUNT(*) n FROM feedback GROUP BY kind ORDER BY n DESC"),
      by_surface: all("SELECT surface, COUNT(*) n FROM feedback GROUP BY surface ORDER BY n DESC"),
      per_day: all(
        `SELECT day, COUNT(*) n FROM feedback WHERE day >= date('now', '-30 days')
         GROUP BY day ORDER BY day`,
      ),
      items: all(
        `SELECT ts, kind, rating, message, contact, surface, version, country, device
         FROM feedback ORDER BY id DESC LIMIT 200`,
      ),
    };
  });

  // ── Public transparency feed: heavily aggregated, no auth, cached ─────────
  let publicCache: { at: number; body: unknown } | null = null;
  const publicCacheMs = options.publicCacheMs ?? 60_000;
  app.get("/public", async (req, reply) => {
    corsHeaders(req, reply);
    reply.header("cache-control", "public, max-age=60");
    if (publicCache && Date.now() - publicCache.at < publicCacheMs) return publicCache.body;
    const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
    const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    let relayOnline = false;
    try {
      const health = await fetch(options.relayHealthUrl ?? "http://127.0.0.1:8443/healthz", {
        signal: AbortSignal.timeout(2000),
      });
      relayOnline = health.ok;
    } catch {
      relayOnline = false;
    }
    const body = {
      generated_at: new Date().toISOString(),
      relay_online: relayOnline,
      totals: {
        pageviews: one("SELECT COUNT(*) n FROM hits WHERE kind = 'pageview'"),
        downloads: one("SELECT COUNT(*) n FROM hits WHERE kind = 'download'"),
      },
      rating: db
        .prepare(
          "SELECT ROUND(AVG(rating), 2) avg, COUNT(*) n FROM feedback WHERE rating IS NOT NULL",
        )
        .get(),
      per_day: all(
        `SELECT day, SUM(kind = 'pageview') views, COUNT(DISTINCT visitor) visitors
         FROM hits WHERE kind = 'pageview' AND day >= date('now', '-30 days')
         GROUP BY day ORDER BY day`,
      ),
      by_country: all(
        `SELECT country, COUNT(*) n FROM hits WHERE country IS NOT NULL AND kind = 'pageview'
         GROUP BY country ORDER BY n DESC LIMIT 8`,
      ),
    };
    publicCache = { at: Date.now(), body };
    return body;
  });

  app.addHook("onClose", async () => db.close());
  return app;
}

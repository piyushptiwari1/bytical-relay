import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Owner-only analytics for the local Relay controller (/data). Guarded by a
 * password that lives ONLY in the local config file — never in the repository.
 * Reads the controller's own SQLite stores read-only; nothing leaves the machine.
 */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const startedAt = Date.now();

interface ConsoleSession {
  expires: number;
}

export class DataConsole {
  readonly #password: string;
  readonly #dataDir: string;
  readonly #sessions = new Map<string, ConsoleSession>();
  readonly #analytics: { url: string; token: string } | null;
  #productCache: { at: number; body: Record<string, unknown> } | null = null;

  constructor(password: string, dataDir: string, analytics?: { url: string; token: string }) {
    this.#password = password;
    this.#dataDir = dataDir;
    this.#analytics = analytics ?? null;
  }

  checkPassword(presented: string): boolean {
    const a = createHash("sha256").update(this.#password).digest();
    const b = createHash("sha256").update(presented).digest();
    return timingSafeEqual(a, b);
  }

  issueSession(): string {
    const token = randomBytes(24).toString("base64url");
    this.#sessions.set(token, { expires: Date.now() + SESSION_TTL_MS });
    return token;
  }

  validSession(cookieHeader: string | undefined): boolean {
    const match = /(?:^|;\s*)rdc_data=([^;]+)/.exec(cookieHeader ?? "");
    if (!match?.[1]) return false;
    const session = this.#sessions.get(decodeURIComponent(match[1]));
    if (!session) return false;
    if (Date.now() > session.expires) {
      this.#sessions.delete(decodeURIComponent(match[1]));
      return false;
    }
    return true;
  }

  /** All aggregates for the console — each store opened read-only, best effort. */
  async stats(): Promise<Record<string, unknown>> {
    return {
      generated_at: new Date().toISOString(),
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      sessions: this.#sessionStats(),
      events: this.#eventStats(),
      devices: this.#deviceStats(),
      audit: this.#auditStats(),
      product: await this.#productStats(),
    };
  }

  /** Website + app + community numbers — fetched from rdc-analytics and GitHub, cached 5 min. */
  async #productStats(): Promise<Record<string, unknown>> {
    if (this.#productCache && Date.now() - this.#productCache.at < 5 * 60_000) {
      return this.#productCache.body;
    }
    const body: Record<string, unknown> = { website: null, community: null, feedback: null };
    if (this.#analytics) {
      const authed = { authorization: `Bearer ${this.#analytics.token}` };
      const base = this.#analytics.url.replace(/\/$/, "");
      try {
        const response = await fetch(`${base}/stats`, {
          headers: authed,
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) body.website = await response.json();
      } catch {
        // analytics offline — console still works
      }
      try {
        const response = await fetch(`${base}/feedback`, {
          headers: authed,
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) body.feedback = await response.json();
      } catch {
        // analytics offline — console still works
      }
    }
    try {
      const repo = await fetch("https://api.github.com/repos/piyushptiwari1/bytical-relay", {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5000),
      });
      if (repo.ok) {
        const data = (await repo.json()) as Record<string, unknown>;
        const releases = await fetch(
          "https://api.github.com/repos/piyushptiwari1/bytical-relay/releases",
          { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(5000) },
        );
        let downloads = 0;
        if (releases.ok) {
          for (const release of (await releases.json()) as Array<{
            assets?: Array<{ download_count?: number }>;
          }>) {
            for (const asset of release.assets ?? []) downloads += asset.download_count ?? 0;
          }
        }
        body.community = {
          stars: data.stargazers_count,
          forks: data.forks_count,
          watchers: data.subscribers_count,
          open_issues: data.open_issues_count,
          release_downloads: downloads,
        };
        const issues = await fetch(
          "https://api.github.com/repos/piyushptiwari1/bytical-relay/issues?state=open&per_page=20",
          { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(5000) },
        );
        if (issues.ok) {
          body.github_issues = ((await issues.json()) as Array<Record<string, unknown>>)
            .filter((issue) => !issue.pull_request)
            .map((issue) => ({
              number: issue.number,
              title: issue.title,
              author: (issue.user as { login?: string } | null)?.login ?? null,
              created_at: issue.created_at,
              comments: issue.comments,
              url: issue.html_url,
              labels: ((issue.labels as Array<{ name?: string }>) ?? []).map((l) => l.name),
            }));
        }
      }
    } catch {
      // rate limited or offline
    }
    this.#productCache = { at: Date.now(), body };
    return body;
  }

  #open(file: string): DatabaseSync | null {
    const full = path.join(this.#dataDir, file);
    if (!existsSync(full)) return null;
    try {
      return new DatabaseSync(full, { readOnly: true });
    } catch {
      return null;
    }
  }

  #sessionStats(): Record<string, unknown> {
    const db = this.#open("sessions.db");
    if (!db) return { total: 0 };
    try {
      const total = (db.prepare("SELECT COUNT(*) n FROM agent_sessions").get() as { n: number }).n;
      const byStatus = db
        .prepare("SELECT status, COUNT(*) n FROM agent_sessions GROUP BY status ORDER BY n DESC")
        .all();
      const byProvider = db
        .prepare(
          "SELECT provider, COUNT(*) n FROM agent_sessions GROUP BY provider ORDER BY n DESC",
        )
        .all();
      const perDay = db
        .prepare(
          `SELECT substr(created_at, 1, 10) day, COUNT(*) n FROM agent_sessions
           WHERE created_at >= datetime('now', '-14 days') GROUP BY day ORDER BY day`,
        )
        .all();
      const queued = (
        db.prepare("SELECT COUNT(*) n FROM queued_agent_prompts").get() as { n: number }
      ).n;
      return { total, by_status: byStatus, by_provider: byProvider, per_day: perDay, queued };
    } catch {
      return { total: 0 };
    } finally {
      db.close();
    }
  }

  #eventStats(): Record<string, unknown> {
    const db = this.#open("events.db");
    if (!db) return { total: 0 };
    try {
      const total = (db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n;
      const byDomain = db
        .prepare(
          `SELECT CASE WHEN instr(stream, ':') > 0 THEN substr(stream, 1, instr(stream, ':') - 1)
                  ELSE stream END domain, COUNT(*) n
           FROM events GROUP BY domain ORDER BY n DESC LIMIT 8`,
        )
        .all();
      const perDay = db
        .prepare(
          `SELECT substr(ts, 1, 10) day, COUNT(*) n FROM events
           WHERE ts >= datetime('now', '-14 days') GROUP BY day ORDER BY day`,
        )
        .all();
      const topTypes = db
        .prepare("SELECT type, COUNT(*) n FROM events GROUP BY type ORDER BY n DESC LIMIT 8")
        .all();
      return { total, by_domain: byDomain, per_day: perDay, top_types: topTypes };
    } catch {
      return { total: 0 };
    } finally {
      db.close();
    }
  }

  #deviceStats(): Record<string, unknown> {
    const db = this.#open("devices.db");
    if (!db) return { total: 0, devices: [] };
    try {
      const devices = db
        .prepare(
          `SELECT name, scopes, revoked, expires_at, last_seen_at, last_transport, created_at
           FROM devices ORDER BY revoked ASC, last_seen_at DESC NULLS LAST`,
        )
        .all() as Array<Record<string, unknown>>;
      const pushTokens = (db.prepare("SELECT COUNT(*) n FROM push_tokens").get() as { n: number })
        .n;
      return {
        total: devices.length,
        active: devices.filter((d) => !d.revoked && Number(d.expires_at) > Date.now()).length,
        push_tokens: pushTokens,
        devices: devices.map((d) => ({
          name: d.name,
          scopes: safeParse(d.scopes as string),
          revoked: Boolean(d.revoked),
          expires_at: d.expires_at,
          last_seen_at: d.last_seen_at,
          last_transport: d.last_transport,
          created_at: d.created_at,
        })),
      };
    } catch {
      return { total: 0, devices: [] };
    } finally {
      db.close();
    }
  }

  #auditStats(): Record<string, unknown> {
    const db = this.#open("audit.db");
    if (!db) return { total: 0 };
    try {
      const total = (db.prepare("SELECT COUNT(*) n FROM audit_entries").get() as { n: number }).n;
      const byAction = db
        .prepare(
          "SELECT action, COUNT(*) n FROM audit_entries GROUP BY action ORDER BY n DESC LIMIT 10",
        )
        .all();
      const byActor = db
        .prepare(
          "SELECT actor, COUNT(*) n FROM audit_entries GROUP BY actor ORDER BY n DESC LIMIT 8",
        )
        .all();
      const perDay = db
        .prepare(
          `SELECT substr(ts, 1, 10) day, COUNT(*) n FROM audit_entries
           WHERE ts >= datetime('now', '-14 days') GROUP BY day ORDER BY day`,
        )
        .all();
      return { total, by_action: byAction, by_actor: byActor, per_day: perDay };
    } catch {
      return { total: 0 };
    } finally {
      db.close();
    }
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

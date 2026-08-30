import { DatabaseSync } from "node:sqlite";

const LEGACY_DEFAULT_SCOPES = ["projects.read", "files.read", "events.read"];
export const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Capabilities granted after an owner confirms physical device pairing. */
const PREVIOUS_DEFAULT_DEVICE_SCOPES = [
  "machine.read",
  "machine.control",
  "projects.read",
  "files.read",
  "events.read",
  "git.read",
  "editor.read",
  "editor.control",
  "agents.read",
  "agents.control",
  "terminals.read",
  "notifications.manage",
] as const;

export const DEFAULT_DEVICE_SCOPES = [
  ...PREVIOUS_DEFAULT_DEVICE_SCOPES,
  "device.self_manage",
] as const;

export interface DeviceRecord {
  device_id: string;
  name: string;
  kx_pub: string;
  token_hash: string;
  scopes: string[];
  expires_at: number;
  created_at: string;
  revoked: boolean;
  last_seen_at: string | null;
  last_transport: "direct" | "relay" | null;
  install_id: string | null;
}

/** Paired-device registry (PairingGrant persistence, PLAN §20). */
export class DeviceStore {
  readonly #db: DatabaseSync;

  constructor(dbPath = ":memory:") {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kx_pub TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        last_transport TEXT
      );
      CREATE TABLE IF NOT EXISTS push_tokens (
        device_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.#addColumn("expires_at INTEGER");
    this.#addColumn("last_seen_at TEXT");
    this.#addColumn("last_transport TEXT");
    this.#addColumn("install_id TEXT");
    this.#db
      .prepare("UPDATE devices SET expires_at = ? WHERE expires_at IS NULL")
      .run(Date.now() + DEVICE_TOKEN_TTL_MS);
    this.#upgradeLegacyScopes();
  }

  add(
    device: Omit<
      DeviceRecord,
      "created_at" | "revoked" | "last_seen_at" | "last_transport" | "install_id"
    > & { install_id?: string | null },
  ): void {
    this.#db
      .prepare(
        `INSERT INTO devices (device_id, name, kx_pub, token_hash, scopes, expires_at, created_at, install_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        device.device_id,
        device.name,
        device.kx_pub,
        device.token_hash,
        JSON.stringify(device.scopes),
        device.expires_at,
        new Date().toISOString(),
        device.install_id ?? null,
      );
  }

  /** Latest device row for a physical install (revoked rows included so a
   * re-confirmed pairing resurrects the same identity, PLAN §20). */
  findByInstallId(installId: string): DeviceRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM devices WHERE install_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(installId) as Record<string, unknown> | undefined;
    return row ? this.#toRecord(row) : undefined;
  }

  /** Re-pair an existing device: rotate crypto + token, reset to safe default
   * scopes, un-revoke. The previous token dies immediately. */
  repair(
    deviceId: string,
    next: { name: string; kx_pub: string; token_hash: string; expires_at: number },
  ): boolean {
    const info = this.#db
      .prepare(
        `UPDATE devices
         SET name = ?, kx_pub = ?, token_hash = ?, expires_at = ?, scopes = ?, revoked = 0
         WHERE device_id = ?`,
      )
      .run(
        next.name,
        next.kx_pub,
        next.token_hash,
        next.expires_at,
        JSON.stringify(DEFAULT_DEVICE_SCOPES),
        deviceId,
      );
    return Number(info.changes) > 0;
  }

  findByTokenHash(tokenHash: string): DeviceRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM devices WHERE token_hash = ? AND revoked = 0 AND expires_at > ?")
      .get(tokenHash, Date.now()) as Record<string, unknown> | undefined;
    return row ? this.#toRecord(row) : undefined;
  }

  get(deviceId: string): DeviceRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#toRecord(row) : undefined;
  }

  list(): DeviceRecord[] {
    const rows = this.#db.prepare("SELECT * FROM devices ORDER BY created_at").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => this.#toRecord(r));
  }

  revoke(deviceId: string): boolean {
    const info = this.#db
      .prepare("UPDATE devices SET revoked = 1 WHERE device_id = ?")
      .run(deviceId);
    return Number(info.changes) > 0;
  }

  revokeAll(): number {
    const info = this.#db.prepare("UPDATE devices SET revoked = 1 WHERE revoked = 0").run();
    return Number(info.changes);
  }

  rotateToken(deviceId: string, tokenHash: string, expiresAt: number): boolean {
    const info = this.#db
      .prepare(
        `UPDATE devices
         SET token_hash = ?, expires_at = ?
         WHERE device_id = ? AND revoked = 0`,
      )
      .run(tokenHash, expiresAt, deviceId);
    return Number(info.changes) > 0;
  }

  markSeen(deviceId: string, transport: "direct" | "relay"): boolean {
    const info = this.#db
      .prepare(
        `UPDATE devices
         SET last_seen_at = ?, last_transport = ?
         WHERE device_id = ? AND revoked = 0 AND expires_at > ?`,
      )
      .run(new Date().toISOString(), transport, deviceId, Date.now());
    return Number(info.changes) > 0;
  }

  setPushToken(deviceId: string, token: string): void {
    this.#db
      .prepare(
        "INSERT INTO push_tokens (device_id, token, updated_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at",
      )
      .run(deviceId, token, new Date().toISOString());
  }

  pushTokenOf(deviceId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT token FROM push_tokens WHERE device_id = ?")
      .get(deviceId) as { token?: string } | undefined;
    return row?.token;
  }

  allPushTokens(requiredScope?: string): string[] {
    const rows = this.#db
      .prepare(
        `SELECT push_tokens.token, devices.scopes
         FROM push_tokens
         INNER JOIN devices ON devices.device_id = push_tokens.device_id
         WHERE devices.revoked = 0 AND devices.expires_at > ?`,
      )
      .all(Date.now()) as Array<{ token: string; scopes: string }>;
    return rows
      .filter((row) => {
        if (!requiredScope) return true;
        try {
          const scopes = JSON.parse(row.scopes) as unknown;
          return Array.isArray(scopes) && (scopes.includes("*") || scopes.includes(requiredScope));
        } catch {
          return false;
        }
      })
      .map((row) => row.token);
  }

  removePushToken(token: string): void {
    this.#db.prepare("DELETE FROM push_tokens WHERE token = ?").run(token);
  }

  #toRecord(row: Record<string, unknown>): DeviceRecord {
    return {
      device_id: row.device_id as string,
      name: row.name as string,
      kx_pub: row.kx_pub as string,
      token_hash: row.token_hash as string,
      scopes: JSON.parse(row.scopes as string) as string[],
      expires_at: Number(row.expires_at),
      created_at: row.created_at as string,
      revoked: Number(row.revoked) === 1,
      last_seen_at: (row.last_seen_at as string | null) ?? null,
      last_transport: (row.last_transport as DeviceRecord["last_transport"]) ?? null,
      install_id: (row.install_id as string | null) ?? null,
    };
  }

  #addColumn(definition: string): void {
    try {
      this.#db.exec(`ALTER TABLE devices ADD COLUMN ${definition}`);
    } catch {
      // Existing database already has this migration.
    }
  }

  /** Existing pairings predate enforced scopes; safely reduce them to the new core grant. */
  #upgradeLegacyScopes(): void {
    const rows = this.#db.prepare("SELECT device_id, scopes FROM devices").all() as Array<{
      device_id: string;
      scopes: string;
    }>;
    for (const row of rows) {
      try {
        const scopes = JSON.parse(row.scopes) as unknown;
        if (
          !Array.isArray(scopes) ||
          (!isExactScopeSet(scopes, LEGACY_DEFAULT_SCOPES) &&
            !isExactScopeSet(scopes, PREVIOUS_DEFAULT_DEVICE_SCOPES))
        ) {
          continue;
        }
        this.#db
          .prepare("UPDATE devices SET scopes = ? WHERE device_id = ?")
          .run(JSON.stringify(DEFAULT_DEVICE_SCOPES), row.device_id);
      } catch {
        // Corrupt scope data remains untouched and is denied by the dispatcher.
      }
    }
  }

  close(): void {
    this.#db.close();
  }
}

function isExactScopeSet(scopes: unknown[], expected: readonly string[]): boolean {
  return scopes.length === expected.length && expected.every((scope) => scopes.includes(scope));
}

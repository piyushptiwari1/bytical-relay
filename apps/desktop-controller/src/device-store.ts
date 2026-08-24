import { DatabaseSync } from "node:sqlite";

export interface DeviceRecord {
  device_id: string;
  name: string;
  kx_pub: string;
  token_hash: string;
  scopes: string[];
  created_at: string;
  revoked: boolean;
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
        created_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS push_tokens (
        device_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  add(device: Omit<DeviceRecord, "created_at" | "revoked">): void {
    this.#db
      .prepare(
        "INSERT INTO devices (device_id, name, kx_pub, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        device.device_id,
        device.name,
        device.kx_pub,
        device.token_hash,
        JSON.stringify(device.scopes),
        new Date().toISOString(),
      );
  }

  findByTokenHash(tokenHash: string): DeviceRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM devices WHERE token_hash = ? AND revoked = 0")
      .get(tokenHash) as Record<string, unknown> | undefined;
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

  allPushTokens(): string[] {
    const rows = this.#db.prepare("SELECT token FROM push_tokens").all() as Array<{
      token: string;
    }>;
    return rows.map((r) => r.token);
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
      created_at: row.created_at as string,
      revoked: Number(row.revoked) === 1,
    };
  }

  close(): void {
    this.#db.close();
  }
}

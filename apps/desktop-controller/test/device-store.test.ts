import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_DEVICE_SCOPES, DeviceStore } from "../src/device-store.ts";

describe("DeviceStore", () => {
  test("install_id: find latest row and repair in place", () => {
    const store = new DeviceStore(":memory:");
    store.add({
      device_id: "dev_phone",
      name: "Pixel 7",
      kx_pub: "pk-1",
      token_hash: "th-1",
      scopes: ["projects.read"],
      expires_at: Date.now() + 60_000,
      install_id: "inst_abc",
    });
    expect(store.findByInstallId("inst_abc")?.device_id).toBe("dev_phone");
    expect(store.findByInstallId("inst_missing")).toBeUndefined();

    // revoked devices are still found — a confirmed re-pair resurrects them
    store.revoke("dev_phone");
    expect(store.findByInstallId("inst_abc")?.revoked).toBe(true);

    const expiresAt = Date.now() + 120_000;
    expect(
      store.repair("dev_phone", {
        name: "Pixel 7 Pro",
        kx_pub: "pk-2",
        token_hash: "th-2",
        expires_at: expiresAt,
      }),
    ).toBe(true);
    const repaired = store.get("dev_phone");
    expect(repaired).toMatchObject({
      name: "Pixel 7 Pro",
      kx_pub: "pk-2",
      revoked: false,
      install_id: "inst_abc",
    });
    expect(repaired?.scopes).toEqual([...DEFAULT_DEVICE_SCOPES]);
    expect(store.findByTokenHash("th-1")).toBeUndefined(); // old credential dead
    expect(store.findByTokenHash("th-2")?.device_id).toBe("dev_phone");
    expect(store.list()).toHaveLength(1); // still one row per physical device
    store.close();
  });

  test("upgrades only the former implicit default grant", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rdc-device-"));
    const dbPath = path.join(dir, "devices.db");
    try {
      const original = new DeviceStore(dbPath);
      original.add({
        device_id: "dev_legacy",
        name: "old phone",
        kx_pub: "key",
        token_hash: "hash",
        scopes: ["projects.read", "files.read", "events.read"],
        expires_at: Date.now() + 60_000,
      });
      original.add({
        device_id: "dev_custom",
        name: "limited phone",
        kx_pub: "key-2",
        token_hash: "hash-2",
        scopes: ["projects.read"],
        expires_at: Date.now() + 60_000,
      });
      original.add({
        device_id: "dev_previous_default",
        name: "earlier upgraded phone",
        kx_pub: "key-3",
        token_hash: "hash-3",
        scopes: [
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
        ],
        expires_at: Date.now() + 60_000,
      });
      original.close();

      const migrated = new DeviceStore(dbPath);
      expect(migrated.findByTokenHash("hash")?.scopes).toEqual(DEFAULT_DEVICE_SCOPES);
      expect(migrated.findByTokenHash("hash-2")?.scopes).toEqual(["projects.read"]);
      expect(migrated.findByTokenHash("hash-3")?.scopes).toEqual(DEFAULT_DEVICE_SCOPES);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects expired tokens, rotates valid tokens, and records presence", () => {
    const store = new DeviceStore(":memory:");
    const now = Date.now();
    store.add({
      device_id: "dev_lifecycle",
      name: "phone",
      kx_pub: "key",
      token_hash: "old-hash",
      scopes: ["projects.read"],
      expires_at: now + 60_000,
    });
    store.add({
      device_id: "dev_expired",
      name: "old phone",
      kx_pub: "expired-key",
      token_hash: "expired-hash",
      scopes: ["projects.read"],
      expires_at: now - 1,
    });

    expect(store.findByTokenHash("expired-hash")).toBeUndefined();
    expect(store.markSeen("dev_lifecycle", "relay")).toBe(true);
    expect(store.get("dev_lifecycle")).toMatchObject({ last_transport: "relay" });
    expect(store.rotateToken("dev_lifecycle", "new-hash", now + 120_000)).toBe(true);
    expect(store.findByTokenHash("old-hash")).toBeUndefined();
    expect(store.findByTokenHash("new-hash")?.expires_at).toBe(now + 120_000);
    store.close();
  });

  test("sends push only to active devices with the required scope", () => {
    const store = new DeviceStore(":memory:");
    const now = Date.now();
    for (const [deviceId, scopes, expiresAt] of [
      ["dev_allowed", ["agents.control"], now + 60_000],
      ["dev_limited", ["projects.read"], now + 60_000],
      ["dev_expired", ["agents.control"], now - 1],
    ] as const) {
      store.add({
        device_id: deviceId,
        name: deviceId,
        kx_pub: `${deviceId}-key`,
        token_hash: `${deviceId}-token`,
        scopes: [...scopes],
        expires_at: expiresAt,
      });
      store.setPushToken(deviceId, `${deviceId}-push-token`);
    }
    store.revoke("dev_limited");

    expect(store.allPushTokens("agents.control")).toEqual(["dev_allowed-push-token"]);
    expect(store.allPushTokens()).toEqual(["dev_allowed-push-token"]);
    store.close();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_DEVICE_SCOPES, DeviceStore } from "../src/device-store.ts";

describe("DeviceStore", () => {
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
      });
      original.add({
        device_id: "dev_custom",
        name: "limited phone",
        kx_pub: "key-2",
        token_hash: "hash-2",
        scopes: ["projects.read"],
      });
      original.close();

      const migrated = new DeviceStore(dbPath);
      expect(migrated.findByTokenHash("hash")?.scopes).toEqual(DEFAULT_DEVICE_SCOPES);
      expect(migrated.findByTokenHash("hash-2")?.scopes).toEqual(["projects.read"]);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { AuditLog } from "../src/audit-log.ts";

describe("AuditLog", () => {
  test("persists a verifiable chain across a controller restart", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rdc-audit-"));
    const dbPath = path.join(dir, "audit.db");
    try {
      const first = new AuditLog(dbPath);
      first.append({
        ts: "2026-08-30T00:00:00.000Z",
        actor: "dev_phone",
        action: "agent.prompt",
        details: { outcome: "accepted", session_id: "ses_test" },
      });
      first.close();

      const reopened = new AuditLog(dbPath);
      reopened.append({
        ts: "2026-08-30T00:01:00.000Z",
        actor: "dev_phone",
        action: "approval.respond",
        details: { outcome: "accepted", approval_id: "apr_test" },
      });
      expect(reopened.entries()).toHaveLength(2);
      expect(reopened.verify()).toEqual({ valid: true });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

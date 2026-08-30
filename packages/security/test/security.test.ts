import { describe, expect, test } from "vitest";
import {
  appendAuditEntry,
  type ChainedAuditEntry,
  hasScope,
  issueRelayTicket,
  issueRelayTicketBundle,
  issueToken,
  verifyAuditChain,
  verifyRelayTicket,
  verifyToken,
} from "../src/index.ts";

describe("opaque tokens", () => {
  test("issue → verify happy path, scopes included", () => {
    const t0 = 1_000_000;
    const { token, record } = issueToken("dev_1", ["files.read", "agents.control"], 60_000, t0);
    expect(verifyToken(record, token, t0 + 1)).toBe(true);
    expect(hasScope(record, "files.read")).toBe(true);
    expect(hasScope(record, "git.push")).toBe(false);
  });

  test("rejects wrong token and expired token", () => {
    const t0 = 1_000_000;
    const { token, record } = issueToken("dev_1", [], 60_000, t0);
    const other = issueToken("dev_2", [], 60_000, t0);
    expect(verifyToken(record, other.token, t0 + 1)).toBe(false);
    expect(verifyToken(record, token, t0 + 60_000)).toBe(false);
  });

  test("record never contains the raw token", () => {
    const { token, record } = issueToken("dev_1", [], 1000);
    expect(JSON.stringify(record)).not.toContain(token);
  });
});

describe("hash-chained audit log", () => {
  function buildChain(): ChainedAuditEntry[] {
    const chain: ChainedAuditEntry[] = [];
    appendAuditEntry(chain, {
      ts: "2026-08-22T10:00:00Z",
      actor: "phone_1",
      action: "approval.respond",
      details: { approved: true },
    });
    appendAuditEntry(chain, {
      ts: "2026-08-22T10:01:00Z",
      actor: "agent_claude",
      action: "terminal.exec",
      details: { cmd: "git commit" },
    });
    appendAuditEntry(chain, {
      ts: "2026-08-22T10:02:00Z",
      actor: "phone_1",
      action: "pairing.revoke",
    });
    return chain;
  }

  test("valid chain verifies", () => {
    expect(verifyAuditChain(buildChain())).toEqual({ valid: true });
  });

  test("tampering with any field breaks the chain at that entry", () => {
    const tamperedAction = buildChain();
    tamperedAction[1] = { ...tamperedAction[1]!, action: "terminal.exec-hidden" };
    expect(verifyAuditChain(tamperedAction)).toEqual({ valid: false, brokenAt: 2 });

    const droppedEntry = buildChain().filter((e) => e.seq !== 2);
    expect(verifyAuditChain(droppedEntry).valid).toBe(false);

    const reordered = buildChain().reverse();
    expect(verifyAuditChain(reordered).valid).toBe(false);
  });
});

describe("relay access tickets", () => {
  test("are device-bound, signed, and time-bounded", () => {
    const now = 1_000_000;
    const issued = issueRelayTicket("relay-secret", {
      machine_id: "mch_1",
      device_id: "dev_1",
      not_before: now - 1,
      expires_at: now + 60_000,
    });
    expect(verifyRelayTicket("relay-secret", issued.ticket, now)).toMatchObject({
      machine_id: "mch_1",
      device_id: "dev_1",
    });
    expect(verifyRelayTicket("other-secret", issued.ticket, now)).toBeNull();
    expect(verifyRelayTicket("relay-secret", `${issued.ticket}x`, now)).toBeNull();
    expect(verifyRelayTicket("relay-secret", issued.ticket, now + 60_000)).toBeNull();
  });

  test("issues a rolling bundle with one active current ticket", () => {
    const now = 1_234_567_890;
    const tickets = issueRelayTicketBundle("relay-secret", {
      machineId: "mch_1",
      deviceId: "dev_1",
      now,
      windows: 3,
    });
    expect(tickets).toHaveLength(3);
    expect(
      tickets.filter((ticket) => verifyRelayTicket("relay-secret", ticket.ticket, now)),
    ).toHaveLength(1);
  });
});

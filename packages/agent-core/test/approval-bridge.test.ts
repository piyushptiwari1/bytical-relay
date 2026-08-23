import { describe, expect, test } from "vitest";
import { ApprovalBridge } from "../src/approval-bridge.ts";

const ask = {
  title: "Run git push",
  tool_kind: "execute",
  options: [
    { option_id: "allow", name: "Allow", option_kind: "allow_once" },
    { option_id: "reject", name: "Reject", option_kind: "reject_once" },
  ],
};

describe("ApprovalBridge", () => {
  test("respond resolves the pending answer with the chosen option", async () => {
    const bridge = new ApprovalBridge();
    const { request, answer } = bridge.create("ses_1", ask);
    expect(bridge.pendingFor("ses_1")).toHaveLength(1);
    expect(bridge.respond(request.approval_id, "allow")?.session_id).toBe("ses_1");
    await expect(answer).resolves.toEqual({ option_id: "allow" });
    expect(bridge.pendingFor("ses_1")).toHaveLength(0);
    expect(bridge.respond(request.approval_id, "allow")).toBeNull(); // idempotent
  });

  test("session cancel resolves all pending as cancelled", async () => {
    const bridge = new ApprovalBridge();
    const a = bridge.create("ses_2", ask);
    const b = bridge.create("ses_2", ask);
    const other = bridge.create("ses_3", ask);
    bridge.cancelForSession("ses_2");
    await expect(a.answer).resolves.toEqual({ cancelled: true });
    await expect(b.answer).resolves.toEqual({ cancelled: true });
    expect(bridge.pendingFor("ses_3")).toHaveLength(1);
    bridge.respond(other.request.approval_id, "reject");
  });

  test("timeout auto-cancels", async () => {
    const bridge = new ApprovalBridge(30);
    const { answer } = bridge.create("ses_4", ask);
    await expect(answer).resolves.toEqual({ cancelled: true });
  });
});

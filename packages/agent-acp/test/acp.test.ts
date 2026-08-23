import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionAsk } from "@rdc/agent-core";
import type { AgentUpdate } from "@rdc/protocol";
import { describe, expect, test } from "vitest";
import { AcpAdapter } from "../src/acp-adapter.ts";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs");

function fakeAdapter(): AcpAdapter {
  return new AcpAdapter({
    id: "fake",
    command: process.execPath,
    argsFor: () => [fixture],
    detectArgs: ["--version"],
  });
}

describe("AcpAdapter against a scripted ACP agent", () => {
  test("full prompt turn: updates stream, permission allow, end_turn", async () => {
    const updates: AgentUpdate[] = [];
    const asks: PermissionAsk[] = [];
    const session = await fakeAdapter().createSession({
      cwd: process.cwd(),
      callbacks: {
        onUpdate: (u) => updates.push(u),
        onPermission: async (ask) => {
          asks.push(ask);
          return { option_id: "allow" };
        },
        onExit: () => {},
      },
    });
    expect(session.providerSessionId).toBe("fake-session-1");

    const result = await session.prompt("create hello.txt");
    expect(result.stop_reason).toBe("end_turn");

    expect(asks).toHaveLength(1);
    expect(asks[0]?.title).toBe("Write hello.txt");
    expect(asks[0]?.options.map((o) => o.option_id)).toEqual(["allow", "reject"]);

    const kinds = updates.map((u) => u.kind);
    expect(kinds).toContain("thought_chunk");
    expect(kinds).toContain("message_chunk");
    const tools = updates.filter((u) => u.kind === "tool_call");
    expect(tools.at(-1)).toMatchObject({ tool_id: "tc1", status: "completed" });
    await session.dispose();
  });

  test("rejection path fails the tool", async () => {
    const updates: AgentUpdate[] = [];
    const session = await fakeAdapter().createSession({
      cwd: process.cwd(),
      callbacks: {
        onUpdate: (u) => updates.push(u),
        onPermission: async () => ({ option_id: "reject" }),
        onExit: () => {},
      },
    });
    await session.prompt("try something");
    const tools = updates.filter((u) => u.kind === "tool_call");
    expect(tools.at(-1)).toMatchObject({ status: "failed" });
    await session.dispose();
  });

  test("detect reports availability from --version exit code", async () => {
    const result = await fakeAdapter().detect();
    expect(result.available).toBe(true);
  });
});

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpAdapter } from "./acp-adapter.ts";

/**
 * Claude Code rides the same ACP contract as Copilot via Zed's maintained
 * bridge (`@zed-industries/claude-code-acp`): sessions, streamed updates,
 * permission asks, and cancel all arrive identically, so the controller,
 * phone, and journal need zero provider-specific code.
 */
function resolveBridgeCommand(): { command: string; args: string[] } {
  if (process.env.RDC_CLAUDE_ACP_PATH && existsSync(process.env.RDC_CLAUDE_ACP_PATH)) {
    return { command: process.env.RDC_CLAUDE_ACP_PATH, args: [] };
  }
  const globalBin =
    process.platform === "win32"
      ? path.join(
          process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"),
          "npm/claude-code-acp.cmd",
        )
      : "/usr/local/bin/claude-code-acp";
  if (existsSync(globalBin)) return { command: globalBin, args: [] };
  // zero-install fallback — npx fetches the bridge on first session
  return { command: "npx", args: ["-y", "@zed-industries/claude-code-acp"] };
}

class ClaudeAdapter extends AcpAdapter {
  /** Availability = the underlying `claude` CLI exists and answers; the ACP
   * bridge itself is fetched on demand and needs no separate probe. */
  override detect(): Promise<{ available: boolean; detail: string }> {
    return new Promise((resolve) => {
      const child = spawn("claude --version", [], {
        shell: true,
        windowsHide: true,
      });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve({ available: false, detail: "claude CLI not responding" });
      }, 15_000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ available: false, detail: "Claude Code CLI not installed" });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({
            available: true,
            detail: `${output.trim().split("\n")[0] ?? "claude"} · ACP bridge`,
          });
        } else {
          resolve({ available: false, detail: "Claude Code CLI not installed" });
        }
      });
    });
  }
}

export const claudeAdapter = (): ClaudeAdapter => {
  const bridge = resolveBridgeCommand();
  return new ClaudeAdapter({
    id: "claude",
    command: bridge.command,
    argsFor: () => bridge.args,
    windowsShim: true,
  });
};

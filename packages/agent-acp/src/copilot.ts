import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpAdapter } from "./acp-adapter.ts";

/**
 * Resolve the REAL GitHub Copilot CLI. On PATH, VS Code's copilot-chat shim
 * (globalStorage/.../copilotCli/copilot.bat) often shadows it — that shim
 * prompts "Install? (y/N)" on stdin and would hang an ACP spawn forever.
 */
function resolveCopilotCommand(): string {
  if (process.env.RDC_COPILOT_PATH && existsSync(process.env.RDC_COPILOT_PATH)) {
    return process.env.RDC_COPILOT_PATH;
  }
  if (process.platform === "win32") {
    const candidates = [
      path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"),
        "npm/copilot.cmd",
      ),
      path.join(os.homedir(), "AppData/Local/Programs/copilot/copilot.exe"),
    ];
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  } else {
    for (const candidate of [
      "/usr/local/bin/copilot",
      path.join(os.homedir(), ".local/bin/copilot"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return "copilot";
}

/**
 * GitHub Copilot CLI ≥1.0.80 in ACP server mode (`copilot --acp`). Shares the
 * user's existing Copilot subscription (GitHub sign-in). `--add-dir` scopes
 * file access to the project root.
 */
export const copilotAdapter = (): AcpAdapter =>
  new AcpAdapter({
    id: "copilot",
    command: resolveCopilotCommand(),
    argsFor: (cwd) => ["--acp", "--add-dir", cwd],
    detectArgs: ["--version"],
    windowsShim: true,
  });

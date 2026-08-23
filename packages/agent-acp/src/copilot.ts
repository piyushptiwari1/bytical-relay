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
class CopilotAdapter extends AcpAdapter {
  /**
   * The CLI persists every conversation (laptop TUI and our ACP sessions
   * alike) in ~/.copilot/session-store.db — reading it gives the shared
   * laptop⇄phone history; ACP session/load resumes any of them in-context.
   */
  async listNativeSessions(): Promise<
    Array<{ native_id: string; title: string; cwd: string; updated_at: string }>
  > {
    const dbPath = path.join(os.homedir(), ".copilot", "session-store.db");
    if (!existsSync(dbPath)) return [];
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id, cwd, summary, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50",
        )
        .all() as Array<{ id: string; cwd: string; summary: string | null; updated_at: string }>;
      return rows.map((row) => ({
        native_id: row.id,
        title: row.summary?.trim() || "Untitled session",
        cwd: row.cwd,
        updated_at: row.updated_at,
      }));
    } finally {
      db.close();
    }
  }
}

export const copilotAdapter = (): CopilotAdapter =>
  new CopilotAdapter({
    id: "copilot",
    command: resolveCopilotCommand(),
    argsFor: (cwd) => ["--acp", "--add-dir", cwd],
    detectArgs: ["--version"],
    windowsShim: true,
  });

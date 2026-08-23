import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface VsCodeChatSummary {
  id: string;
  title: string;
  workspace_path: string;
  updated_at: string;
  turns: number;
}

export interface VsCodeChatTurn {
  role: "user" | "assistant";
  text: string;
}

interface SessionFile {
  file: string;
  workspacePath: string;
}

/**
 * Read-only bridge to VS Code's Copilot Chat panel history. VS Code persists
 * each panel conversation as workspaceStorage/<hash>/chatSessions/<id>.json
 * (format observed: requests[].message.text + response[].value parts,
 * customTitle, lastMessageDate). There is no public API for this — tolerant
 * parsing only, and any file we can't parse is silently skipped so future
 * VS Code format changes degrade gracefully instead of breaking.
 */
export class VsCodeChatReader {
  readonly #roots: string[];
  #index = new Map<string, SessionFile>();

  constructor(roots?: string[]) {
    this.#roots = roots ?? defaultStorageRoots();
  }

  list(): VsCodeChatSummary[] {
    const results: VsCodeChatSummary[] = [];
    this.#index = new Map();
    for (const root of this.#roots) {
      let hashes: string[] = [];
      try {
        hashes = readdirSync(root);
      } catch {
        continue;
      }
      for (const hash of hashes) {
        const dir = path.join(root, hash);
        const workspacePath = readWorkspaceFolder(path.join(dir, "workspace.json"));
        if (!workspacePath) continue;
        let files: string[] = [];
        try {
          files = readdirSync(path.join(dir, "chatSessions")).filter((f) => f.endsWith(".json"));
        } catch {
          continue;
        }
        for (const name of files) {
          const file = path.join(dir, "chatSessions", name);
          const summary = this.#summarize(file, workspacePath);
          if (summary) results.push(summary);
        }
      }
    }
    return results.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 50);
  }

  /** Full turn list for one chat (call list() first to build the index). */
  transcript(id: string): { workspacePath: string; turns: VsCodeChatTurn[] } | null {
    const entry = this.#index.get(id);
    if (!entry) return null;
    try {
      const session = JSON.parse(readFileSync(entry.file, "utf8")) as {
        requests?: Array<{
          message?: { text?: string };
          response?: Array<{ kind?: string; value?: unknown }>;
        }>;
      };
      const turns: VsCodeChatTurn[] = [];
      for (const request of session.requests ?? []) {
        const userText = request.message?.text?.trim();
        if (userText) turns.push({ role: "user", text: userText });
        const assistantText = responseText(request.response);
        if (assistantText) turns.push({ role: "assistant", text: assistantText });
      }
      return { workspacePath: entry.workspacePath, turns };
    } catch {
      return null;
    }
  }

  #summarize(file: string, workspacePath: string): VsCodeChatSummary | null {
    try {
      const session = JSON.parse(readFileSync(file, "utf8")) as {
        sessionId?: string;
        customTitle?: string;
        lastMessageDate?: number | string;
        requests?: Array<{ message?: { text?: string } }>;
      };
      const requests = session.requests ?? [];
      if (requests.length === 0) return null;
      const id = `vsc_${session.sessionId ?? path.basename(file, ".json")}`;
      const firstText = requests[0]?.message?.text ?? "VS Code chat";
      const updated = session.lastMessageDate
        ? new Date(session.lastMessageDate).toISOString()
        : statSync(file).mtime.toISOString();
      this.#index.set(id, { file, workspacePath });
      return {
        id,
        title: (session.customTitle?.trim() || firstText).slice(0, 100),
        workspace_path: workspacePath,
        updated_at: updated,
        turns: requests.length,
      };
    } catch {
      return null;
    }
  }
}

function defaultStorageRoots(): string[] {
  const home = os.homedir();
  const bases =
    process.platform === "win32"
      ? [path.join(process.env.APPDATA ?? path.join(home, "AppData/Roaming"))]
      : process.platform === "darwin"
        ? [path.join(home, "Library/Application Support")]
        : [process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")];
  const roots: string[] = [];
  for (const base of bases) {
    for (const product of ["Code", "Code - Insiders"]) {
      roots.push(path.join(base, product, "User", "workspaceStorage"));
    }
  }
  return roots;
}

function readWorkspaceFolder(workspaceJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(workspaceJsonPath, "utf8")) as { folder?: string };
    if (!parsed.folder?.startsWith("file:///")) return null;
    return decodeURIComponent(parsed.folder.slice("file:///".length)).replaceAll("/", path.sep);
  } catch {
    return null;
  }
}

function responseText(parts: Array<{ kind?: string; value?: unknown }> | undefined): string {
  if (!Array.isArray(parts)) return "";
  const markdown = parts
    .filter((p) => p.kind === "markdownContent" && typeof p.value === "string")
    .map((p) => p.value as string);
  if (markdown.length > 0) return markdown.join("").trim();
  return parts
    .filter((p) => typeof p.value === "string")
    .map((p) => p.value as string)
    .join("")
    .trim();
}

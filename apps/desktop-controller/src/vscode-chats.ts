import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
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
  /** mtime+size keyed summary cache — unchanged files are never re-parsed. */
  #cache = new Map<string, { mtimeMs: number; size: number; summary: VsCodeChatSummary | null }>();

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
          files = readdirSync(path.join(dir, "chatSessions")).filter(
            (f) => f.endsWith(".json") || f.endsWith(".jsonl"),
          );
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
    const session = loadSessionFile(entry.file);
    if (!session) return null;
    const turns: VsCodeChatTurn[] = [];
    for (const request of session.requests) {
      const userText = request.message?.text?.trim();
      if (userText) turns.push({ role: "user", text: userText });
      const assistantText = responseText(request.response);
      if (assistantText) turns.push({ role: "assistant", text: assistantText });
    }
    return { workspacePath: entry.workspacePath, turns };
  }

  #summarize(file: string, workspacePath: string): VsCodeChatSummary | null {
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(file);
    } catch {
      return null;
    }
    const cached = this.#cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      if (cached.summary) this.#index.set(cached.summary.id, { file, workspacePath });
      return cached.summary;
    }
    const summary = this.#buildSummary(file, workspacePath, stat);
    this.#cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
    if (summary) this.#index.set(summary.id, { file, workspacePath });
    return summary;
  }

  #buildSummary(
    file: string,
    workspacePath: string,
    stat: { mtimeMs: number; size: number },
  ): VsCodeChatSummary | null {
    // Listing path: for .jsonl parse ONLY the snapshot line (cheap); full delta
    // replay happens in transcript(). Legacy .json is small — full parse is fine.
    // Some sessions snapshot BEFORE the first request (requests live only in
    // deltas) — full-parse those, the result is cached by mtime anyway.
    let session = file.endsWith(".jsonl") ? loadSnapshotLine(file) : loadSessionFile(file);
    if (session && session.requests.length === 0 && file.endsWith(".jsonl")) {
      session = loadSessionFile(file);
    }
    if (!session || session.requests.length === 0) return null;
    try {
      const id = `vsc_${session.sessionId ?? path.basename(file).replace(/\.jsonl?$/, "")}`;
      const firstText = session.requests[0]?.message?.text ?? "VS Code chat";
      const updated = new Date(
        Math.max(
          stat.mtimeMs,
          session.lastMessageDate ? new Date(session.lastMessageDate).getTime() : 0,
        ),
      ).toISOString();
      return {
        id,
        title: (session.customTitle?.trim() || firstText).slice(0, 100),
        workspace_path: workspacePath,
        updated_at: updated,
        turns: session.requests.length,
      };
    } catch {
      return null;
    }
  }
}

interface ChatRequest {
  requestId?: string;
  message?: { text?: string };
  response?: Array<{ kind?: string; value?: unknown }>;
}

interface ChatSessionData {
  sessionId?: string;
  customTitle?: string;
  lastMessageDate?: number | string;
  requests: ChatRequest[];
}

const MAX_SESSION_FILE = 20 * 1024 * 1024;

/** Read only the first line of a .jsonl file (the kind:0 session snapshot). */
function loadSnapshotLine(file: string): ChatSessionData | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const chunk = Buffer.alloc(256 * 1024);
    const parts: Buffer[] = [];
    let pos = 0;
    while (pos < MAX_SESSION_FILE) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      const newlineAt = chunk.subarray(0, n).indexOf(0x0a);
      if (newlineAt >= 0) {
        parts.push(Buffer.from(chunk.subarray(0, newlineAt)));
        break;
      }
      parts.push(Buffer.from(chunk.subarray(0, n)));
      pos += n;
    }
    if (parts.length === 0) return null;
    const entry = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
      kind?: number;
      v?: unknown;
    };
    if (entry.kind !== 0 || !entry.v || typeof entry.v !== "object") return null;
    const snapshot = entry.v as Partial<ChatSessionData>;
    return { ...snapshot, requests: snapshot.requests ?? [] };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Load either format: legacy .json (one object) or current .jsonl (line 0 =
 * {kind:0, v:<session snapshot>}, later kind:2 array deltas may carry FULL new
 * request objects appended after the snapshot). Unknown delta shapes are
 * ignored — format drift degrades to "older snapshot", never a crash.
 */
function loadSessionFile(file: string): ChatSessionData | null {
  try {
    if (statSync(file).size > MAX_SESSION_FILE) return null;
    const raw = readFileSync(file, "utf8");
    if (!file.endsWith(".jsonl")) {
      const parsed = JSON.parse(raw) as Partial<ChatSessionData>;
      return { ...parsed, requests: parsed.requests ?? [] };
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let base: ChatSessionData | null = null;
    const seen = new Set<string>();
    for (const line of lines) {
      let entry: { kind?: number; v?: unknown };
      try {
        entry = JSON.parse(line) as { kind?: number; v?: unknown };
      } catch {
        continue;
      }
      if (entry.kind === 0 && entry.v && typeof entry.v === "object") {
        const snapshot = entry.v as Partial<ChatSessionData>;
        base = { ...snapshot, requests: [...(snapshot.requests ?? [])] };
        for (const request of base.requests) {
          if (request.requestId) seen.add(request.requestId);
        }
        continue;
      }
      if (entry.kind === 2 && Array.isArray(entry.v) && base) {
        for (const item of entry.v as ChatRequest[]) {
          if (item && typeof item === "object" && item.requestId && item.message) {
            if (!seen.has(item.requestId)) {
              seen.add(item.requestId);
              base.requests.push(item);
            }
          }
        }
      }
    }
    return base;
  } catch {
    return null;
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

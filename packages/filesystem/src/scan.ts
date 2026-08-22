import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FileKind } from "@rdc/protocol";
import type { IgnoreEngine } from "./ignore.ts";

export interface ScannedEntry {
  relative_path: string;
  parent_path: string | null;
  name: string;
  kind: FileKind;
  size: number;
  mtime_ms: number;
}

/**
 * BFS walk (parents always precede children — the index relies on this).
 * Symlinks/junctions are never followed (dirents that are links are skipped).
 */
export async function scanProjectTree(
  rootAbs: string,
  ig: IgnoreEngine,
  opts: { maxEntries?: number } = {},
): Promise<ScannedEntry[]> {
  const maxEntries = opts.maxEntries ?? 200_000;
  const out: ScannedEntry[] = [];
  const queue: string[] = [""];
  while (queue.length > 0) {
    const relDir = queue.shift() as string;
    const absDir = relDir ? path.join(rootAbs, relDir) : rootAbs;
    let dirents: Dirent[];
    try {
      dirents = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue; // vanished or unreadable — reconciler will catch up
    }
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      const kind: FileKind | null = d.isDirectory() ? "dir" : d.isFile() ? "file" : null;
      if (kind === null) continue;
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (ig.ignores(rel, kind)) continue;
      let size = 0;
      let mtimeMs = 0;
      if (kind === "file") {
        try {
          const st = await stat(path.join(rootAbs, rel));
          size = st.size;
          mtimeMs = Math.floor(st.mtimeMs);
        } catch {
          continue;
        }
      }
      out.push({
        relative_path: rel,
        parent_path: relDir === "" ? null : relDir,
        name: d.name,
        kind,
        size,
        mtime_ms: mtimeMs,
      });
      if (out.length >= maxEntries) return out;
      if (kind === "dir") queue.push(rel);
    }
  }
  return out;
}

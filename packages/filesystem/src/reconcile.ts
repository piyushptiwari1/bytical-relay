import type { IgnoreEngine } from "./ignore.ts";
import type { AppliedChange, FsIndex } from "./index-db.ts";
import { scanProjectTree } from "./scan.ts";

/**
 * Periodic reconciliation (PLAN §6): stat-walk the disk, diff against the index,
 * return corrective changes. Safety net for missed/overflowed watcher events.
 */
export async function reconcileProject(
  rootAbs: string,
  projectId: string,
  index: FsIndex,
  ig: IgnoreEngine,
): Promise<AppliedChange[]> {
  const scanned = await scanProjectTree(rootAbs, ig);
  const indexed = index.listPaths(projectId);
  const changes: AppliedChange[] = [];
  const seen = new Set<string>();
  for (const s of scanned) {
    seen.add(s.relative_path);
    const row = indexed.get(s.relative_path);
    if (!row) {
      changes.push({
        change: "create",
        relative_path: s.relative_path,
        kind: s.kind,
        size: s.size,
        mtime_ms: s.mtime_ms,
      });
    } else if (s.kind === "file" && (row.size !== s.size || row.mtime_ms !== s.mtime_ms)) {
      changes.push({
        change: "modify",
        relative_path: s.relative_path,
        kind: s.kind,
        size: s.size,
        mtime_ms: s.mtime_ms,
      });
    }
  }
  for (const [rel, row] of indexed) {
    if (!seen.has(rel)) {
      changes.push({ change: "delete", relative_path: rel, kind: row.kind, size: 0, mtime_ms: 0 });
    }
  }
  return changes;
}

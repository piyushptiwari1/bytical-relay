import { DatabaseSync } from "node:sqlite";
import type { FileChange, FileEntry, FileKind, Project } from "@rdc/protocol";
import { newId } from "@rdc/shared";
import type { DetectedProject } from "./detect.ts";
import type { ScannedEntry } from "./scan.ts";

export interface AppliedChange {
  change: "create" | "modify" | "delete";
  relative_path: string;
  kind: FileKind;
  size: number;
  mtime_ms: number;
}

/** SQLite-backed filesystem index (PLAN §6): metadata only, hashes lazy (S2). */
export class FsIndex {
  readonly #db: DatabaseSync;

  constructor(dbPath = ":memory:") {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        vcs TEXT NOT NULL,
        fingerprint TEXT,
        wsl INTEGER NOT NULL DEFAULT 0,
        detected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        file_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        relative_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        hash TEXT,
        UNIQUE (project_id, relative_path)
      );
      CREATE INDEX IF NOT EXISTS idx_files_parent ON files (project_id, parent_id);
    `);
  }

  upsertProject(p: DetectedProject): void {
    this.#db
      .prepare(
        `INSERT INTO projects (project_id, name, root_path, vcs, fingerprint, wsl, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           name = excluded.name, root_path = excluded.root_path, vcs = excluded.vcs,
           fingerprint = excluded.fingerprint, wsl = excluded.wsl`,
      )
      .run(
        p.project_id,
        p.name,
        p.root_path,
        p.vcs,
        p.fingerprint,
        p.wsl ? 1 : 0,
        new Date().toISOString(),
      );
  }

  listProjects(): Array<Omit<Project, "version">> {
    const rows = this.#db
      .prepare(
        "SELECT project_id, name, root_path, vcs, fingerprint, wsl FROM projects ORDER BY name",
      )
      .all() as Array<{
      project_id: string;
      name: string;
      root_path: string;
      vcs: string;
      fingerprint: string | null;
      wsl: number;
    }>;
    return rows.map((r) => ({
      project_id: r.project_id,
      name: r.name,
      root_path: r.root_path,
      vcs: r.vcs === "git" ? "git" : "none",
      fingerprint: r.fingerprint,
      wsl: r.wsl === 1,
    }));
  }

  getProjectRoot(projectId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT root_path FROM projects WHERE project_id = ?")
      .get(projectId) as { root_path: string } | undefined;
    return row?.root_path;
  }

  /** Initial index: atomic wipe + BFS-ordered insert (parents precede children). */
  replaceProjectTree(projectId: string, entries: readonly ScannedEntry[]): number {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM files WHERE project_id = ?").run(projectId);
      const insert = this.#db.prepare(
        "INSERT INTO files (file_id, project_id, parent_id, relative_path, name, kind, size, mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const idByPath = new Map<string, string>();
      for (const e of entries) {
        const fileId = newId();
        const parentId = e.parent_path === null ? null : (idByPath.get(e.parent_path) ?? null);
        insert.run(
          fileId,
          projectId,
          parentId,
          e.relative_path,
          e.name,
          e.kind,
          e.size,
          e.mtime_ms,
        );
        idByPath.set(e.relative_path, fileId);
      }
      this.#db.exec("COMMIT");
      return entries.length;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  childrenOf(projectId: string, parentId: string | null): FileEntry[] {
    // kind ASC: "dir" < "file" lexically → directories first
    const sql =
      parentId === null
        ? "SELECT * FROM files WHERE project_id = ? AND parent_id IS NULL ORDER BY kind ASC, name"
        : "SELECT * FROM files WHERE project_id = ? AND parent_id = ? ORDER BY kind ASC, name";
    const rows = (
      parentId === null
        ? this.#db.prepare(sql).all(projectId)
        : this.#db.prepare(sql).all(projectId, parentId)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.#toEntry(r));
  }

  getByPath(projectId: string, relativePath: string): FileEntry | undefined {
    const row = this.#db
      .prepare("SELECT * FROM files WHERE project_id = ? AND relative_path = ?")
      .get(projectId, relativePath) as Record<string, unknown> | undefined;
    return row ? this.#toEntry(row) : undefined;
  }

  /** Snapshot of all indexed paths — reconciler diffs the disk against this. */
  listPaths(projectId: string): Map<string, { kind: FileKind; size: number; mtime_ms: number }> {
    const rows = this.#db
      .prepare("SELECT relative_path, kind, size, mtime_ms FROM files WHERE project_id = ?")
      .all(projectId) as Array<{
      relative_path: string;
      kind: string;
      size: number;
      mtime_ms: number;
    }>;
    const map = new Map<string, { kind: FileKind; size: number; mtime_ms: number }>();
    for (const r of rows) {
      map.set(r.relative_path, {
        kind: r.kind === "dir" ? "dir" : "file",
        size: Number(r.size),
        mtime_ms: Number(r.mtime_ms),
      });
    }
    return map;
  }

  fileCount(projectId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM files WHERE project_id = ?")
      .get(projectId) as {
      n: number;
    };
    return Number(row.n);
  }

  /**
   * Applies one observed change. Returns the normalized change to journal,
   * or null when it is a no-op (e.g. deleting an already-absent row).
   */
  applyChange(projectId: string, c: AppliedChange): FileChange | null {
    const existing = this.getByPath(projectId, c.relative_path);
    if (c.change === "delete") {
      if (!existing) return null;
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db
          .prepare(
            "DELETE FROM files WHERE project_id = ? AND (relative_path = ? OR relative_path LIKE ?)",
          )
          .run(projectId, c.relative_path, `${c.relative_path}/%`);
        this.#db.exec("COMMIT");
      } catch (cause) {
        this.#db.exec("ROLLBACK");
        throw cause;
      }
      return {
        project_id: projectId,
        change: "delete",
        relative_path: c.relative_path,
        kind: existing.kind,
        old_path: null,
      };
    }
    if (existing) {
      if (
        existing.kind === "file" &&
        (existing.size !== c.size || existing.mtime_ms !== c.mtime_ms)
      ) {
        this.#db
          .prepare(
            "UPDATE files SET size = ?, mtime_ms = ?, hash = NULL WHERE project_id = ? AND relative_path = ?",
          )
          .run(c.size, c.mtime_ms, projectId, c.relative_path);
        return {
          project_id: projectId,
          change: "modify",
          relative_path: c.relative_path,
          kind: existing.kind,
          old_path: null,
        };
      }
      return null; // dir touch or unchanged file
    }
    const parentPath = c.relative_path.includes("/")
      ? c.relative_path.slice(0, c.relative_path.lastIndexOf("/"))
      : null;
    const parentId = parentPath === null ? null : this.#ensureDirChain(projectId, parentPath);
    this.#db
      .prepare(
        "INSERT INTO files (file_id, project_id, parent_id, relative_path, name, kind, size, mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        newId(),
        projectId,
        parentId,
        c.relative_path,
        c.relative_path.split("/").at(-1) as string,
        c.kind,
        c.size,
        c.mtime_ms,
      );
    return {
      project_id: projectId,
      change: "create",
      relative_path: c.relative_path,
      kind: c.kind,
      old_path: null,
    };
  }

  #ensureDirChain(projectId: string, dirPath: string): string {
    const existing = this.getByPath(projectId, dirPath);
    if (existing) return existing.file_id;
    const parentPath = dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : null;
    const parentId = parentPath === null ? null : this.#ensureDirChain(projectId, parentPath);
    const fileId = newId();
    this.#db
      .prepare(
        "INSERT INTO files (file_id, project_id, parent_id, relative_path, name, kind, size, mtime_ms) VALUES (?, ?, ?, ?, ?, 'dir', 0, 0)",
      )
      .run(fileId, projectId, parentId, dirPath, dirPath.split("/").at(-1) as string);
    return fileId;
  }

  #toEntry(r: Record<string, unknown>): FileEntry {
    return {
      file_id: r.file_id as string,
      project_id: r.project_id as string,
      parent_id: (r.parent_id as string | null) ?? null,
      relative_path: r.relative_path as string,
      name: r.name as string,
      kind: r.kind === "dir" ? "dir" : "file",
      size: Number(r.size),
      mtime_ms: Number(r.mtime_ms),
      hash: (r.hash as string | null) ?? null,
    };
  }

  close(): void {
    this.#db.close();
  }
}

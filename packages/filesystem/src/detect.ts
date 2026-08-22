import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { ALWAYS_IGNORED_DIRS } from "./ignore.ts";

export interface DetectedProject {
  project_id: string;
  name: string;
  root_path: string;
  vcs: "git" | "none";
  fingerprint: string | null;
  wsl: boolean;
}

const MARKER_FILES = new Set([
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

/** Identity: first-commit sha (survives moves/clones) else hash of normalized path (PLAN §5). */
async function gitFingerprint(rootAbs: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: rootAbs,
      timeout: 10_000,
    });
    const first = stdout.split("\n")[0]?.trim();
    return first && /^[0-9a-f]{40}$/.test(first) ? first : null;
  } catch {
    return null; // no git, empty repo, or not a repo
  }
}

function pathFallbackId(rootAbs: string): string {
  const normalized = rootAbs.replace(/\\/g, "/").toLowerCase();
  return `path_${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

const isWslPath = (p: string): boolean =>
  p.startsWith("\\\\wsl$") || p.startsWith("\\\\wsl.localhost");

async function classifyDir(absDir: string): Promise<{ isProject: boolean; hasGit: boolean }> {
  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return { isProject: false, hasGit: false };
  }
  let hasGit = false;
  let hasMarker = false;
  for (const d of entries) {
    if (d.isDirectory() && d.name === ".git") hasGit = true;
    else if (d.isFile() && (MARKER_FILES.has(d.name) || d.name.endsWith(".sln"))) hasMarker = true;
  }
  return { isProject: hasGit || hasMarker, hasGit };
}

/** BFS scan of configured roots; detected project roots are not descended into. */
export async function detectProjects(
  roots: readonly string[],
  opts: { maxDepth?: number } = {},
): Promise<DetectedProject[]> {
  const maxDepth = opts.maxDepth ?? 3;
  const found = new Map<string, DetectedProject>();

  async function visit(absDir: string, depth: number): Promise<void> {
    const { isProject, hasGit } = await classifyDir(absDir);
    if (isProject) {
      const fingerprint = hasGit ? await gitFingerprint(absDir) : null;
      const projectId = fingerprint ? `git_${fingerprint}` : pathFallbackId(absDir);
      if (!found.has(projectId)) {
        found.set(projectId, {
          project_id: projectId,
          name: path.basename(absDir),
          root_path: absDir,
          vcs: hasGit ? "git" : "none",
          fingerprint,
          wsl: isWslPath(absDir),
        });
      }
      return; // never descend into a detected project
    }
    if (depth >= maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      if (ALWAYS_IGNORED_DIRS.has(d.name) || d.name.startsWith(".")) continue;
      await visit(path.join(absDir, d.name), depth + 1);
    }
  }

  for (const root of roots) {
    await visit(path.resolve(root), 0);
  }
  return [...found.values()];
}

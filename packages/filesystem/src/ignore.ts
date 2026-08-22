import { readFile } from "node:fs/promises";
import path from "node:path";
import ignoreFactory from "ignore";
import { normalizeRelPath } from "./canonical.ts";

/** Hard-excluded directory names — never indexed regardless of .gitignore. */
export const ALWAYS_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  "target",
  ".idea",
  ".vs",
  ".gradle",
  ".expo",
  ".cache",
  ".pnpm-store",
]);

export class IgnoreEngine {
  #ig = ignoreFactory();

  static async forProject(rootAbs: string): Promise<IgnoreEngine> {
    const engine = new IgnoreEngine();
    try {
      engine.#ig.add(await readFile(path.join(rootAbs, ".gitignore"), "utf8"));
    } catch {
      // no .gitignore — hardcoded exclusions still apply
    }
    return engine;
  }

  ignores(relPath: string, kind: "file" | "dir"): boolean {
    const rel = normalizeRelPath(relPath);
    if (rel === "") return false;
    for (const segment of rel.split("/")) {
      if (ALWAYS_IGNORED_DIRS.has(segment)) return true;
    }
    return this.#ig.ignores(kind === "dir" ? `${rel}/` : rel);
  }
}

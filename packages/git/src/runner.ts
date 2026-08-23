import path from "node:path";
import { execa } from "execa";

const MAX_OUTPUT = 8 * 1024 * 1024;

export interface GitRunResult {
  stdout: string;
  exitCode: number;
}

/** Run system git in a repo. Argv-array only (no shell), no optional locks. */
export async function runGit(
  repoRoot: string,
  args: readonly string[],
  opts: { allowFailure?: boolean } = {},
): Promise<GitRunResult> {
  const result = await execa(
    "git",
    ["--no-optional-locks", "-c", "core.quotepath=false", ...args],
    {
      cwd: repoRoot,
      maxBuffer: MAX_OUTPUT,
      reject: false,
      stripFinalNewline: false,
    },
  );
  const exitCode = result.exitCode ?? -1;
  if (!opts.allowFailure && exitCode !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 500);
    throw new Error(`git ${args[0]} failed (${exitCode}): ${detail}`);
  }
  return { stdout: result.stdout, exitCode };
}

/**
 * Phone-supplied paths go straight into argv — reject anything that could
 * escape the repo or be parsed as a git option.
 */
export function assertSafeRepoPaths(paths: readonly string[]): void {
  for (const p of paths) {
    if (p.startsWith("-")) throw new Error(`unsafe path (option-like): ${p}`);
    if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) throw new Error(`unsafe path (absolute): ${p}`);
    if (p.split(/[\\/]/).includes("..")) throw new Error(`unsafe path (traversal): ${p}`);
  }
}

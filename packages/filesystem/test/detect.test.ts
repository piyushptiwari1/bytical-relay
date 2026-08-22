import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { detectProjects } from "../src/index.ts";

let base: string;
afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe("project detection", () => {
  test("finds git + marker projects, skips ignored dirs, does not double-detect nested", async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "rdc-detect-"));

    // git project with one commit → fingerprint identity
    const gitProj = path.join(base, "git-proj");
    await mkdir(gitProj, { recursive: true });
    await writeFile(path.join(gitProj, "package.json"), "{}");
    execFileSync("git", ["init", "-q"], { cwd: gitProj });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
      {
        cwd: gitProj,
      },
    );
    // nested marker inside the git project must NOT become its own project
    await mkdir(path.join(gitProj, "frontend"), { recursive: true });
    await writeFile(path.join(gitProj, "frontend", "package.json"), "{}");

    // marker-only project (no git) → path-based identity
    const plainProj = path.join(base, "tools", "plain-proj");
    await mkdir(plainProj, { recursive: true });
    await writeFile(path.join(plainProj, "pyproject.toml"), "");

    // noise that must be skipped
    await mkdir(path.join(base, "node_modules", "fake-pkg"), { recursive: true });
    await writeFile(path.join(base, "node_modules", "fake-pkg", "package.json"), "{}");
    await mkdir(path.join(base, "empty-dir"), { recursive: true });

    const projects = await detectProjects([base]);
    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(["git-proj", "plain-proj"]);

    const git = projects.find((p) => p.name === "git-proj");
    expect(git?.vcs).toBe("git");
    expect(git?.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(git?.project_id).toBe(`git_${git?.fingerprint}`);
    expect(git?.wsl).toBe(false);

    const plain = projects.find((p) => p.name === "plain-proj");
    expect(plain?.vcs).toBe("none");
    expect(plain?.fingerprint).toBeNull();
    expect(plain?.project_id).toMatch(/^path_[0-9a-f]{16}$/);
  }, 30_000);
});

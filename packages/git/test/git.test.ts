import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GitService } from "../src/service.ts";

const PROJECT = "git_test_project";
let repo: string;
let service: GitService;

async function git(...args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd: repo });
  return result.stdout;
}

beforeAll(async () => {
  repo = mkdtempSync(path.join(os.tmpdir(), "rdc-git-"));
  await git("init", "-b", "main");
  await git("config", "user.name", "RDC Test");
  await git("config", "user.email", "rdc@test.local");
  await git("config", "core.autocrlf", "false");
  // corporate global hooks (secret scanners etc.) are slow/interactive — not for throwaway repos
  await git("config", "core.hooksPath", ".git/hooks");
  await git("config", "commit.gpgsign", "false");
  service = new GitService();
  service.register({ project_id: PROJECT, root_path: repo });
});

afterAll(async () => {
  await service.stop();
  rmSync(repo, { recursive: true, force: true });
});

describe("GitService end-to-end on a real repo", () => {
  test("unborn branch: untracked file shows up; stage → commit → clean", async () => {
    writeFileSync(path.join(repo, "hello.txt"), "first line\n");
    let state = await service.status(PROJECT);
    expect(state.branch).toBe("main");
    expect(state.oid).toBeNull();
    expect(state.files).toHaveLength(1);
    expect(state.files[0]).toMatchObject({ path: "hello.txt", untracked: true });

    state = await service.stage(PROJECT, ["hello.txt"]);
    expect(state.files[0]).toMatchObject({ path: "hello.txt", index: "A", untracked: false });

    const { oid, summary } = await service.commit(PROJECT, "feat: hello\n\nbody");
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(summary).toBe("feat: hello");

    state = await service.status(PROJECT);
    expect(state.files).toHaveLength(0);
    expect(state.oid).toBe(oid);
  });

  test("modify → diff → stage → unstage round-trip", async () => {
    writeFileSync(path.join(repo, "hello.txt"), "first line\nsecond line\n");
    let state = await service.status(PROJECT);
    expect(state.files[0]).toMatchObject({ path: "hello.txt", index: ".", worktree: "M" });

    const diff = await service.diffFile(PROJECT, "hello.txt", false);
    expect(diff.patch).toContain("+second line");
    expect(diff.binary).toBe(false);
    expect(diff.truncated).toBe(false);

    state = await service.stage(PROJECT, ["hello.txt"]);
    expect(state.files[0]).toMatchObject({ index: "M", worktree: "." });
    const stagedDiff = await service.diffFile(PROJECT, "hello.txt", true);
    expect(stagedDiff.patch).toContain("+second line");

    state = await service.unstage(PROJECT, ["hello.txt"]);
    expect(state.files[0]).toMatchObject({ index: ".", worktree: "M" });
  });

  test("untracked file diff synthesized via --no-index", async () => {
    writeFileSync(path.join(repo, "new file.ts"), "export const x = 1;\n");
    const diff = await service.diffFile(PROJECT, "new file.ts", false);
    expect(diff.patch).toContain("+export const x = 1;");
  });

  test("rename is parsed with orig_path", async () => {
    await git("add", "-A");
    await git("commit", "-m", "checkpoint");
    await git("mv", "hello.txt", "renamed.txt");
    const state = await service.status(PROJECT);
    const renamed = state.files.find((f) => f.path === "renamed.txt");
    expect(renamed).toMatchObject({ index: "R", orig_path: "hello.txt" });
  });

  test("refresh emits only on real change", async () => {
    const seen: number[] = [];
    service.emitter.on("status", (s) => seen.push(s.files.length));
    await service.refresh(PROJECT);
    const after = seen.length;
    await service.refresh(PROJECT); // unchanged → no emit
    expect(seen.length).toBe(after);
    writeFileSync(path.join(repo, "another.txt"), "x\n");
    await service.refresh(PROJECT);
    expect(seen.length).toBe(after + 1);
  });

  test("hostile paths are rejected", async () => {
    await expect(service.stage(PROJECT, ["--exec=evil"])).rejects.toThrow(/unsafe path/);
    await expect(service.stage(PROJECT, ["../outside.txt"])).rejects.toThrow(/unsafe path/);
    await expect(service.stage(PROJECT, ["C:/windows/system32"])).rejects.toThrow(/unsafe path/);
    await expect(service.diffFile(PROJECT, "-Rf", false)).rejects.toThrow(/unsafe path/);
  });
});

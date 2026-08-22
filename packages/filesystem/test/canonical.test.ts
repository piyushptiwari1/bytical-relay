import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { isSensitivePath, normalizeRelPath, resolveInsideProject } from "../src/index.ts";

const tmpRoots: string[] = [];
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rdc-canon-"));
  tmpRoots.push(root);
  return root;
}
afterAll(async () => {
  for (const root of tmpRoots) await rm(root, { recursive: true, force: true });
});

describe("resolveInsideProject — Windows traversal corpus (PLAN §30)", () => {
  test("accepts normal relative paths (both slash styles)", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "a.txt"), "x");
    for (const p of ["a.txt", "src/deep/file.ts", "src\\deep\\file.ts", "./a.txt"]) {
      const res = await resolveInsideProject(root, p);
      expect(res.ok, p).toBe(true);
    }
  });

  test("rejects the attack corpus", async () => {
    const root = await makeRoot();
    const attacks = [
      "..\\secrets.txt",
      "../secrets.txt",
      "src/../../escape.txt",
      "C:\\Windows\\system32\\config",
      "C:/Windows/notepad.exe",
      "\\\\server\\share\\x",
      "file.txt:hidden:$DATA",
      "file.txt:stream",
      "CON",
      "con.txt",
      "COM1",
      "NUL.log",
      "trailing.dot.",
      "trailing.space ",
      "nested/PRN/file.txt",
      "bad\u0000name.txt",
      "",
      ".",
    ];
    for (const p of attacks) {
      const res = await resolveInsideProject(root, p);
      expect(res.ok, JSON.stringify(p)).toBe(false);
    }
  });

  test("normalizeRelPath canonicalizes separators", () => {
    expect(normalizeRelPath("a\\b\\\\c/")).toBe("a/b/c");
    expect(normalizeRelPath("./x/y")).toBe("x/y");
  });
});

describe("sensitive-path deny overlay", () => {
  test("flags secret files, passes normal files", () => {
    for (const p of [
      ".env",
      ".env.local",
      "certs/server.pem",
      "id_rsa",
      "deep/dir/credentials.json",
      ".npmrc",
    ]) {
      expect(isSensitivePath(p), p).toBe(true);
    }
    for (const p of ["src/env.ts", "README.md", "keys.md", "environment.yaml"]) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });
});

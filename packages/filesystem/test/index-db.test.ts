import { describe, expect, test } from "vitest";
import { FsIndex, type ScannedEntry } from "../src/index.ts";

const project = {
  project_id: "git_abc",
  name: "demo",
  root_path: "C:/tmp/demo",
  vcs: "git" as const,
  fingerprint: "abc",
  wsl: false,
};

function seedTree(): FsIndex {
  const index = new FsIndex(":memory:");
  index.upsertProject(project);
  const entries: ScannedEntry[] = [
    { relative_path: "src", parent_path: null, name: "src", kind: "dir", size: 0, mtime_ms: 0 },
    {
      relative_path: "src/app.ts",
      parent_path: "src",
      name: "app.ts",
      kind: "file",
      size: 100,
      mtime_ms: 1000,
    },
    {
      relative_path: "src/util.ts",
      parent_path: "src",
      name: "util.ts",
      kind: "file",
      size: 50,
      mtime_ms: 1000,
    },
    {
      relative_path: "README.md",
      parent_path: null,
      name: "README.md",
      kind: "file",
      size: 10,
      mtime_ms: 500,
    },
  ];
  index.replaceProjectTree("git_abc", entries);
  return index;
}

describe("FsIndex", () => {
  test("replaceProjectTree links parents; childrenOf paginates by parent", () => {
    const index = seedTree();
    const roots = index.childrenOf("git_abc", null);
    expect(roots.map((e) => e.name)).toEqual(["src", "README.md"]); // dirs first
    const srcId = roots.find((e) => e.name === "src")?.file_id as string;
    const children = index.childrenOf("git_abc", srcId);
    expect(children.map((e) => e.name)).toEqual(["app.ts", "util.ts"]);
    expect(children.every((e) => e.parent_id === srcId)).toBe(true);
    expect(index.fileCount("git_abc")).toBe(4);
    index.close();
  });

  test("applyChange: create auto-builds parent dirs and journals only real changes", () => {
    const index = seedTree();
    const created = index.applyChange("git_abc", {
      change: "create",
      relative_path: "src/deep/new.ts",
      kind: "file",
      size: 5,
      mtime_ms: 2000,
    });
    expect(created?.change).toBe("create");
    expect(index.getByPath("git_abc", "src/deep")?.kind).toBe("dir"); // ensured chain
    // repeat with identical metadata → no-op
    const repeat = index.applyChange("git_abc", {
      change: "create",
      relative_path: "src/deep/new.ts",
      kind: "file",
      size: 5,
      mtime_ms: 2000,
    });
    expect(repeat).toBeNull();
    index.close();
  });

  test("applyChange: modify updates size/mtime and clears hash; delete cascades", () => {
    const index = seedTree();
    const modified = index.applyChange("git_abc", {
      change: "modify",
      relative_path: "src/app.ts",
      kind: "file",
      size: 120,
      mtime_ms: 3000,
    });
    expect(modified?.change).toBe("modify");
    expect(index.getByPath("git_abc", "src/app.ts")?.size).toBe(120);

    const deleted = index.applyChange("git_abc", {
      change: "delete",
      relative_path: "src",
      kind: "dir",
      size: 0,
      mtime_ms: 0,
    });
    expect(deleted?.change).toBe("delete");
    expect(index.getByPath("git_abc", "src/app.ts")).toBeUndefined(); // descendants gone
    expect(
      index.applyChange("git_abc", {
        change: "delete",
        relative_path: "src",
        kind: "dir",
        size: 0,
        mtime_ms: 0,
      }),
    ).toBeNull();
    index.close();
  });
});

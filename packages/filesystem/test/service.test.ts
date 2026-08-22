import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryEventStore } from "@rdc/event-store";
import { fsStream } from "@rdc/protocol";
import { afterAll, describe, expect, test, vi } from "vitest";
import { type DetectedProject, FilesystemService, FsIndex } from "../src/index.ts";

let root: string;
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function project(rootPath: string): DetectedProject {
  return {
    project_id: "git_service_test",
    name: "svc",
    root_path: rootPath,
    vcs: "git",
    fingerprint: "deadbeef",
    wsl: false,
  };
}

describe("FilesystemService end-to-end", () => {
  test("index → watch → journal → reconcile", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "rdc-svc-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.ts"), "export {};");
    await writeFile(path.join(root, "README.md"), "# hi");

    const index = new FsIndex(":memory:");
    const events = new MemoryEventStore();
    const service = new FilesystemService(index, events);
    const proj = project(root);
    const stream = fsStream(proj.project_id);

    // initial scan indexes without journaling
    const count = await service.addProject(proj);
    expect(count).toBe(3);
    expect(events.headSeq(stream)).toBe(0);
    expect(service.projectsWithVersion()[0]?.version).toBe(0);

    // live watch: create + delete journal file.changed events with growing seq
    await service.startWatching(proj.project_id);
    await writeFile(path.join(root, "src", "b.ts"), "export const b = 1;");
    await vi.waitFor(
      () => {
        if (index.getByPath(proj.project_id, "src/b.ts") === undefined)
          throw new Error("not yet indexed");
      },
      { timeout: 8000, interval: 100 },
    );
    await vi.waitFor(
      () => {
        if (events.headSeq(stream) < 1) throw new Error("no event yet");
      },
      { timeout: 8000, interval: 100 },
    );
    const firstEvents = events.read(stream, 0);
    expect(
      firstEvents.some(
        (e) => (e.payload as { relative_path: string }).relative_path === "src/b.ts",
      ),
    ).toBe(true);

    await unlink(path.join(root, "src", "b.ts"));
    await vi.waitFor(
      () => {
        if (index.getByPath(proj.project_id, "src/b.ts") !== undefined)
          throw new Error("still indexed");
      },
      { timeout: 8000, interval: 100 },
    );
    await service.stop();

    // reconcile catches offline changes (watcher stopped)
    await writeFile(path.join(root, "offline.txt"), "made while watcher was off");
    const applied = await service.reconcile(proj.project_id);
    expect(applied).toBeGreaterThanOrEqual(1);
    expect(index.getByPath(proj.project_id, "offline.txt")?.kind).toBe("file");

    // project_version = journal headSeq
    expect(service.projectsWithVersion()[0]?.version).toBe(events.headSeq(stream));
    index.close();
  }, 30_000);
});

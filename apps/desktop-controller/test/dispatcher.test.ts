import { MemoryEventStore } from "@rdc/event-store";
import { FilesystemService, FsIndex } from "@rdc/filesystem";
import {
  DebugEcho,
  FileList,
  Hello,
  ProjectList,
  parseInbound,
  SUPPORTED_VERSIONS,
  SyncSubscribe,
} from "@rdc/protocol";
import { describe, expect, test } from "vitest";
import { ControllerDispatcher, newClientContext } from "../src/dispatcher.ts";

function makeDeps() {
  const fsIndex = new FsIndex(":memory:");
  const eventStore = new MemoryEventStore();
  const fsService = new FilesystemService(fsIndex, eventStore);
  fsIndex.upsertProject({
    project_id: "git_x",
    name: "x",
    root_path: "C:/tmp/x",
    vcs: "git",
    fingerprint: "x".repeat(40),
    wsl: false,
  });
  fsIndex.replaceProjectTree("git_x", [
    { relative_path: "src", parent_path: null, name: "src", kind: "dir", size: 0, mtime_ms: 0 },
    {
      relative_path: "src/a.ts",
      parent_path: "src",
      name: "a.ts",
      kind: "file",
      size: 1,
      mtime_ms: 1,
    },
  ]);
  return { machineId: "mch_test", fsService, fsIndex, eventStore };
}

function parse(raw: string) {
  const result = parseInbound(raw);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("ControllerDispatcher", () => {
  test("hello gate: commands before hello are refused", () => {
    const dispatcher = new ControllerDispatcher(makeDeps());
    const ctx = newClientContext();
    const [refused] = dispatcher
      .handle(JSON.stringify(ProjectList.createRequest({})), ctx)
      .map(parse);
    if (refused?.type === "project.list.result" && refused.payload.status === "error") {
      expect(refused.payload.error.code).toBe("FORBIDDEN");
    } else {
      throw new Error("expected FORBIDDEN error result");
    }
  });

  test("hello → project.list → file.list → subscribe → idempotent echo", () => {
    const dispatcher = new ControllerDispatcher(makeDeps());
    const ctx = newClientContext();

    const [ack] = dispatcher
      .handle(
        JSON.stringify(Hello.create({ protocol: SUPPORTED_VERSIONS, device_id: "test" })),
        ctx,
      )
      .map(parse);
    expect(ack?.type).toBe("hello_ack");
    expect(ctx.helloDone).toBe(true);

    const [projects] = dispatcher
      .handle(JSON.stringify(ProjectList.createRequest({})), ctx)
      .map(parse);
    if (projects?.type === "project.list.result" && projects.payload.status === "ok") {
      expect(projects.payload.result.projects).toHaveLength(1);
      expect(projects.payload.result.projects[0]?.project_id).toBe("git_x");
      expect(projects.payload.result.projects[0]?.version).toBe(0);
    } else {
      throw new Error("project.list failed");
    }

    const [rootList] = dispatcher
      .handle(JSON.stringify(FileList.createRequest({ project_id: "git_x", parent_id: null })), ctx)
      .map(parse);
    if (rootList?.type === "file.list.result" && rootList.payload.status === "ok") {
      expect(rootList.payload.result.entries.map((e) => e.name)).toEqual(["src"]);
    } else {
      throw new Error("file.list failed");
    }

    const [missing] = dispatcher
      .handle(JSON.stringify(FileList.createRequest({ project_id: "nope", parent_id: null })), ctx)
      .map(parse);
    if (missing?.type === "file.list.result" && missing.payload.status === "error") {
      expect(missing.payload.error.code).toBe("NOT_FOUND");
    } else {
      throw new Error("expected NOT_FOUND");
    }

    const [sub] = dispatcher
      .handle(JSON.stringify(SyncSubscribe.createRequest({ streams: ["fs:git_x"] })), ctx)
      .map(parse);
    expect(sub?.type).toBe("sync.subscribe.result");
    expect(ctx.subscriptions.has("fs:git_x")).toBe(true);

    const echoReq = DebugEcho.createRequest({ text: "hi" });
    const [first] = dispatcher.handle(JSON.stringify(echoReq), ctx).map(parse);
    const [retry] = dispatcher.handle(JSON.stringify(echoReq), ctx).map(parse);
    if (
      first?.type === "debug.echo.result" &&
      first.payload.status === "ok" &&
      retry?.type === "debug.echo.result" &&
      retry.payload.status === "ok"
    ) {
      expect(first.payload.duplicate).toBe(false);
      expect(retry.payload.duplicate).toBe(true);
    } else {
      throw new Error("echo round-trip failed");
    }
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryEventStore } from "@rdc/event-store";
import { FilesystemService, FsIndex } from "@rdc/filesystem";
import { GitService } from "@rdc/git";
import {
  DebugEcho,
  EditorList,
  EditorOpenFile,
  EditorPublishState,
  FileList,
  FileRead,
  Hello,
  MachineKeepAwake,
  MachineStatus,
  ProjectList,
  parseInbound,
  SUPPORTED_VERSIONS,
  SyncSubscribe,
} from "@rdc/protocol";
import { describe, expect, test } from "vitest";
import { AgentManager } from "../src/agent-manager.ts";
import { ControllerDispatcher, newClientContext } from "../src/dispatcher.ts";
import { EditorRegistry } from "../src/editors.ts";
import { KeepAwake } from "../src/keep-awake.ts";
import { HealthMonitor } from "../src/machine-health.ts";

const fakeAwakeStrategy = { supported: true, activate() {}, deactivate() {} };

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
  return {
    machineId: "mch_test",
    fsService,
    fsIndex,
    eventStore,
    health: new HealthMonitor(),
    keepAwake: new KeepAwake(fakeAwakeStrategy),
    git: new GitService(),
    editors: new EditorRegistry(),
    agents: new AgentManager({ eventStore, fsIndex }, []),
  };
}

function parse(raw: string) {
  const result = parseInbound(raw);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("ControllerDispatcher", () => {
  async function send(
    dispatcher: ControllerDispatcher,
    ctx: ReturnType<typeof newClientContext>,
    msg: unknown,
  ) {
    const [first] = (await dispatcher.handle(JSON.stringify(msg), ctx)).map(parse);
    return first;
  }

  test("hello gate: commands before hello are refused", async () => {
    const dispatcher = new ControllerDispatcher(makeDeps());
    const ctx = newClientContext();
    const refused = await send(dispatcher, ctx, ProjectList.createRequest({}));
    if (refused?.type === "project.list.result" && refused.payload.status === "error") {
      expect(refused.payload.error.code).toBe("FORBIDDEN");
    } else {
      throw new Error("expected FORBIDDEN error result");
    }
  });

  test("editor: publish → list → open_file routed to matching window", async () => {
    const deps = makeDeps();
    const dispatcher = new ControllerDispatcher(deps);

    const extCtx = newClientContext();
    const extInbox: string[] = [];
    deps.editors.attach(extCtx, (json) => extInbox.push(json));
    await send(
      dispatcher,
      extCtx,
      Hello.create({ protocol: SUPPORTED_VERSIONS, device_id: "ext" }),
    );
    const published = await send(
      dispatcher,
      extCtx,
      EditorPublishState.createRequest({
        state: {
          editor_id: "vscode_test",
          app: "vscode",
          workspace: "x",
          project_ids: ["git_x"],
          active_file: null,
          diagnostics: { errors: 2, warnings: 1, infos: 0 },
          running_tasks: ["build"],
          last_command: null,
          updated_at: new Date().toISOString(),
        },
      }),
    );
    expect(published?.type).toBe("editor.publish_state.result");

    const phoneCtx = newClientContext();
    deps.editors.attach(phoneCtx, () => {});
    await send(
      dispatcher,
      phoneCtx,
      Hello.create({ protocol: SUPPORTED_VERSIONS, device_id: "ph" }),
    );
    const listed = await send(dispatcher, phoneCtx, EditorList.createRequest({}));
    if (listed?.type === "editor.list.result" && listed.payload.status === "ok") {
      expect(listed.payload.result.editors).toHaveLength(1);
      expect(listed.payload.result.editors[0]?.diagnostics.errors).toBe(2);
    } else {
      throw new Error("editor.list failed");
    }

    const opened = await send(
      dispatcher,
      phoneCtx,
      EditorOpenFile.createRequest({ project_id: "git_x", relative_path: "src/a.ts", line: 7 }),
    );
    if (opened?.type === "editor.open_file.result" && opened.payload.status === "ok") {
      expect(opened.payload.result.delivered).toBe(1);
    } else {
      throw new Error("editor.open_file failed");
    }
    const routed = parse(extInbox[0] ?? "");
    expect(routed.type).toBe("editor.open_requested");
    if (routed.type === "editor.open_requested") {
      expect(routed.payload).toMatchObject({ relative_path: "src/a.ts", line: 7 });
    }

    deps.editors.detach(extCtx);
    const after = await send(dispatcher, phoneCtx, EditorList.createRequest({}));
    if (after?.type === "editor.list.result" && after.payload.status === "ok") {
      expect(after.payload.result.editors).toHaveLength(0);
    }
  });

  test("hello → project.list → file.list → subscribe → idempotent echo", async () => {
    const dispatcher = new ControllerDispatcher(makeDeps());
    const ctx = newClientContext();

    const ack = await send(
      dispatcher,
      ctx,
      Hello.create({ protocol: SUPPORTED_VERSIONS, device_id: "test" }),
    );
    expect(ack?.type).toBe("hello_ack");
    expect(ctx.helloDone).toBe(true);

    const projects = await send(dispatcher, ctx, ProjectList.createRequest({}));
    if (projects?.type === "project.list.result" && projects.payload.status === "ok") {
      expect(projects.payload.result.projects).toHaveLength(1);
      expect(projects.payload.result.projects[0]?.project_id).toBe("git_x");
      expect(projects.payload.result.projects[0]?.version).toBe(0);
    } else {
      throw new Error("project.list failed");
    }

    const rootList = await send(
      dispatcher,
      ctx,
      FileList.createRequest({ project_id: "git_x", parent_id: null }),
    );
    if (rootList?.type === "file.list.result" && rootList.payload.status === "ok") {
      expect(rootList.payload.result.entries.map((e) => e.name)).toEqual(["src"]);
    } else {
      throw new Error("file.list failed");
    }

    const missing = await send(
      dispatcher,
      ctx,
      FileList.createRequest({ project_id: "nope", parent_id: null }),
    );
    if (missing?.type === "file.list.result" && missing.payload.status === "error") {
      expect(missing.payload.error.code).toBe("NOT_FOUND");
    } else {
      throw new Error("expected NOT_FOUND");
    }

    const sub = await send(dispatcher, ctx, SyncSubscribe.createRequest({ streams: ["fs:git_x"] }));
    expect(sub?.type).toBe("sync.subscribe.result");
    expect(ctx.subscriptions.has("fs:git_x")).toBe(true);

    const echoReq = DebugEcho.createRequest({ text: "hi" });
    const first = await send(dispatcher, ctx, echoReq);
    const retry = await send(dispatcher, ctx, echoReq);
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

  test("file.read: content round-trip, cap/truncation, traversal + sensitive denial", async () => {
    const deps = makeDeps();
    const root = mkdtempSync(path.join(os.tmpdir(), "rdc-read-"));
    writeFileSync(path.join(root, "hello.ts"), "export const hi = 1;\n");
    writeFileSync(path.join(root, ".env"), "SECRET=x\n");
    deps.fsIndex.upsertProject({
      project_id: "git_read",
      name: "read",
      root_path: root,
      vcs: "none",
      fingerprint: null,
      wsl: false,
    });
    const dispatcher = new ControllerDispatcher(deps);
    const ctx = newClientContext();
    await send(dispatcher, ctx, Hello.create({ protocol: SUPPORTED_VERSIONS, device_id: "t" }));

    const ok = await send(
      dispatcher,
      ctx,
      FileRead.createRequest({ project_id: "git_read", relative_path: "hello.ts" }),
    );
    if (ok?.type === "file.read.result" && ok.payload.status === "ok") {
      expect(ok.payload.result.encoding).toBe("utf8");
      expect(ok.payload.result.content).toContain("export const hi");
      expect(ok.payload.result.truncated).toBe(false);
    } else {
      throw new Error("file.read failed");
    }

    const capped = await send(
      dispatcher,
      ctx,
      FileRead.createRequest({ project_id: "git_read", relative_path: "hello.ts", max_bytes: 5 }),
    );
    if (capped?.type === "file.read.result" && capped.payload.status === "ok") {
      expect(capped.payload.result.content).toBe("expor");
      expect(capped.payload.result.truncated).toBe(true);
    } else {
      throw new Error("capped read failed");
    }

    for (const attack of ["../outside.txt", "CON", "a:b.txt"]) {
      const denied = await send(
        dispatcher,
        ctx,
        FileRead.createRequest({ project_id: "git_read", relative_path: attack }),
      );
      if (denied?.type === "file.read.result" && denied.payload.status === "error") {
        expect(denied.payload.error.code).toBe("FORBIDDEN");
      } else {
        throw new Error(`expected FORBIDDEN for ${attack}`);
      }
    }

    const sensitive = await send(
      dispatcher,
      ctx,
      FileRead.createRequest({ project_id: "git_read", relative_path: ".env" }),
    );
    if (sensitive?.type === "file.read.result" && sensitive.payload.status === "error") {
      expect(sensitive.payload.error.code).toBe("FORBIDDEN");
      expect(sensitive.payload.error.message).toContain("sensitive");
    } else {
      throw new Error("expected sensitive denial");
    }
  });

  test("machine.status and machine.keep_awake round-trip", async () => {
    const dispatcher = new ControllerDispatcher(makeDeps());
    const ctx = newClientContext();
    await send(dispatcher, ctx, Hello.create({ protocol: SUPPORTED_VERSIONS, device_id: "t" }));

    const status = await send(dispatcher, ctx, MachineStatus.createRequest({}));
    if (status?.type === "machine.status.result" && status.payload.status === "ok") {
      expect(status.payload.result.memory.total_bytes).toBeGreaterThan(0);
      expect(status.payload.result.keep_awake).toEqual({
        supported: true,
        enabled: false,
        until: null,
      });
    } else {
      throw new Error("machine.status failed");
    }

    const on = await send(
      dispatcher,
      ctx,
      MachineKeepAwake.createRequest({ enabled: true, ttl_minutes: 30 }),
    );
    if (on?.type === "machine.keep_awake.result" && on.payload.status === "ok") {
      expect(on.payload.result.enabled).toBe(true);
      expect(on.payload.result.until).not.toBeNull();
    } else {
      throw new Error("keep_awake enable failed");
    }

    const off = await send(dispatcher, ctx, MachineKeepAwake.createRequest({ enabled: false }));
    if (off?.type === "machine.keep_awake.result" && off.payload.status === "ok") {
      expect(off.payload.result.enabled).toBe(false);
    } else {
      throw new Error("keep_awake disable failed");
    }
  });
});

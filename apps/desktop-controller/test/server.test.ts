import net from "node:net";
import { MemoryEventStore } from "@rdc/event-store";
import { FilesystemService, FsIndex } from "@rdc/filesystem";
import { GitService } from "@rdc/git";
import { FileChanged, fsStream, Hello, SUPPORTED_VERSIONS, SyncSubscribe } from "@rdc/protocol";
import { generateKxKeypair, hashToken } from "@rdc/security";
import { newEventId, nowIso } from "@rdc/shared";
import { TerminalManager } from "@rdc/terminal";
import { afterAll, describe, expect, test } from "vitest";
import { AgentManager } from "../src/agent-manager.ts";
import { DeviceStore } from "../src/device-store.ts";
import { EditorRegistry } from "../src/editors.ts";
import { KeepAwake } from "../src/keep-awake.ts";
import { HealthMonitor } from "../src/machine-health.ts";
import { PairingCoordinator } from "../src/pairing-coordinator.ts";
import { buildServer } from "../src/server.ts";

const TOKEN = "test-token-0123456789abcdef0123456789abcdef";

function makeDeps() {
  const fsIndex = new FsIndex(":memory:");
  const eventStore = new MemoryEventStore();
  const fsService = new FilesystemService(fsIndex, eventStore);
  fsIndex.upsertProject({
    project_id: "git_y",
    name: "y",
    root_path: "C:/tmp/y",
    vcs: "git",
    fingerprint: "y".repeat(40),
    wsl: false,
  });
  const keys = generateKxKeypair();
  const devices = new DeviceStore(":memory:");
  const pairing = new PairingCoordinator({
    keys,
    devices,
    machineId: "mch_srv",
    machineName: "test-host",
  });
  return {
    machineId: "mch_srv",
    machineName: "test-host",
    localToken: TOKEN,
    keys,
    devices,
    pairing,
    fsService,
    fsIndex,
    eventStore,
    health: new HealthMonitor(),
    keepAwake: new KeepAwake({ supported: true, activate() {}, deactivate() {} }),
    git: new GitService(),
    editors: new EditorRegistry(),
    terminals: new TerminalManager(),
    agents: new AgentManager({ eventStore, fsIndex }, []),
  };
}

/** Minimal WS client: queues inbound messages, awaits them one by one. */
function wsClient(url: string) {
  const socket = new WebSocket(url);
  const queue: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    const waiter = waiters.shift();
    waiter ? waiter(value) : queue.push(value);
  });
  return {
    socket,
    opened: new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws error")));
    }),
    next(timeoutMs = 5000): Promise<unknown> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for ws message")),
          timeoutMs,
        );
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
    send(message: unknown): void {
      socket.send(JSON.stringify(message));
    },
  };
}

const closers: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

describe("controller server", () => {
  test("healthz open; everything else requires the local token", async () => {
    const { app } = await buildServer(makeDeps());
    closers.push(() => app.close());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { machine_id: string }).machine_id).toBe("mch_srv");

    expect((await fetch(`http://127.0.0.1:${port}/dash`)).status).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/dash`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(200);
    // DNS-rebinding defense: valid token but foreign Host header → 403.
    // fetch/undici refuse to forge Host, so use a raw socket.
    const rawStatus = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          `GET /dash HTTP/1.1\r\nHost: evil.example.com\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`,
        );
      });
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
      });
      socket.on("end", () => {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buffer)?.[1]);
        Number.isFinite(status)
          ? resolve(status)
          : reject(new Error(`no status line in: ${buffer.slice(0, 100)}`));
      });
      socket.on("error", reject);
    });
    expect(rawStatus).toBe(403);
  });

  test("only the local owner can manage redacted paired-device records", async () => {
    const deps = makeDeps();
    const deviceToken = "paired-device-token-0123456789abcdef";
    deps.devices.add({
      device_id: "dev_manage",
      name: "Phone",
      kx_pub: "public-key-material",
      token_hash: hashToken(deviceToken),
      scopes: ["projects.read"],
      expires_at: Date.now() + 60_000,
    });
    const { app } = await buildServer(deps);
    closers.push(() => app.close());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    const listed = await fetch(`http://127.0.0.1:${port}/api/devices`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { devices: Array<Record<string, unknown>> };
    expect(body.devices[0]).toMatchObject({
      device_id: "dev_manage",
      name: "Phone",
      connected: false,
    });
    expect(body.devices[0]).not.toHaveProperty("kx_pub");
    expect(body.devices[0]).not.toHaveProperty("token_hash");

    const pairedList = await fetch(`http://127.0.0.1:${port}/api/devices`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(pairedList.status).toBe(403);

    const revoked = await fetch(`http://127.0.0.1:${port}/api/devices/dev_manage/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(revoked.status).toBe(200);
    expect(deps.devices.get("dev_manage")?.revoked).toBe(true);
  });

  test("ws: hello → subscribe → journaled event is pushed live", async () => {
    const deps = makeDeps();
    const { app } = await buildServer(deps);
    closers.push(() => app.close());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    const unauthorized = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const closed = await new Promise<boolean>((resolve) => {
      unauthorized.addEventListener("close", () => resolve(true));
      unauthorized.addEventListener("open", () => resolve(false));
    });
    expect(closed).toBe(true);

    const client = wsClient(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    closers.push(() => client.socket.close());
    await client.opened;

    client.send(Hello.create({ protocol: SUPPORTED_VERSIONS, device_id: "phone_test" }));
    const ack = (await client.next()) as { type: string; payload: { machine_id: string } };
    expect(ack.type).toBe("hello_ack");

    const stream = fsStream("git_y");
    client.send(SyncSubscribe.createRequest({ streams: [stream] }));
    const sub = (await client.next()) as { type: string };
    expect(sub.type).toBe("sync.subscribe.result");

    // journal an event exactly like FilesystemService does → must be pushed
    const stored = deps.eventStore.append(stream, [
      {
        event_id: newEventId(),
        type: FileChanged.type,
        ts: nowIso(),
        payload: {
          project_id: "git_y",
          change: "create",
          relative_path: "src/new.ts",
          kind: "file",
          old_path: null,
        },
      },
    ]);
    deps.fsService.emitter.emit("events", stored);

    const pushed = (await client.next()) as {
      type: string;
      stream: string;
      seq: number;
      payload: { relative_path: string };
    };
    expect(pushed.type).toBe("file.changed");
    expect(pushed.stream).toBe(stream);
    expect(pushed.seq).toBe(1);
    expect(pushed.payload.relative_path).toBe("src/new.ts");
  });

  test("/data owner console: disabled without config, password-gated with it", async () => {
    // disabled: no dataConsole dep → 404
    const { app: plain } = await buildServer(makeDeps());
    closers.push(() => plain.close());
    expect((await plain.inject({ method: "GET", url: "/data" })).statusCode).toBe(404);

    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dataDir = mkdtempSync(join(tmpdir(), "rdc-data-"));
    const { app } = await buildServer({
      ...makeDeps(),
      dataConsole: { password: "Sup3r-secret", dataDir },
    });
    closers.push(() => app.close());

    // unauthenticated: login page, and stats API refuses
    const page = await app.inject({ method: "GET", url: "/data" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("data console");
    expect((await app.inject({ method: "GET", url: "/api/data/stats" })).statusCode).toBe(401);

    // wrong password rejected
    const bad = await app.inject({
      method: "POST",
      url: "/data/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=nope-nope",
    });
    expect(bad.statusCode).toBe(401);

    // right password issues session cookie; stats become readable
    const ok = await app.inject({
      method: "POST",
      url: "/data/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=Sup3r-secret",
    });
    expect(ok.statusCode).toBe(302);
    const cookie = String(ok.headers["set-cookie"]).split(";")[0];
    const stats = await app.inject({
      method: "GET",
      url: "/api/data/stats",
      headers: { cookie },
    });
    expect(stats.statusCode).toBe(200);
    const parsed = stats.json() as { sessions: { total: number }; devices: { total: number } };
    expect(parsed.sessions.total).toBe(0);
    expect(parsed.devices.total).toBe(0);
  });
});

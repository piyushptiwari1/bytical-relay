import net from "node:net";
import { MemoryEventStore } from "@rdc/event-store";
import { FilesystemService, FsIndex } from "@rdc/filesystem";
import { FileChanged, fsStream, Hello, SUPPORTED_VERSIONS, SyncSubscribe } from "@rdc/protocol";
import { newEventId, nowIso } from "@rdc/shared";
import { afterAll, describe, expect, test } from "vitest";
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
  return { machineId: "mch_srv", localToken: TOKEN, fsService, fsIndex, eventStore };
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
    const app = await buildServer(makeDeps());
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

  test("ws: hello → subscribe → journaled event is pushed live", async () => {
    const deps = makeDeps();
    const app = await buildServer(deps);
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
});

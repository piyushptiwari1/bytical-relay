import { MemoryEventStore } from "@rdc/event-store";
import { FilesystemService, FsIndex } from "@rdc/filesystem";
import { GitService } from "@rdc/git";
import { FileChanged, fsStream, type KnownMessage, ProjectList } from "@rdc/protocol";
import { emojiFingerprint, fromB64, generateKxKeypair } from "@rdc/security";
import { newEventId, nowIso } from "@rdc/shared";
import { TerminalManager } from "@rdc/terminal";
import { ControllerClient, pairWithController } from "@rdc/transport";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AgentManager } from "../src/agent-manager.ts";
import { DeviceStore } from "../src/device-store.ts";
import { EditorRegistry } from "../src/editors.ts";
import { KeepAwake } from "../src/keep-awake.ts";
import { HealthMonitor } from "../src/machine-health.ts";
import { PairingCoordinator } from "../src/pairing-coordinator.ts";
import { buildServer, type ServerDeps } from "../src/server.ts";

const LOCAL_TOKEN = "local-token-0123456789abcdef0123456789abcdef";

let deps: ServerDeps;
let port: number;
const closers: Array<() => Promise<unknown> | unknown> = [];

beforeAll(async () => {
  const fsIndex = new FsIndex(":memory:");
  const eventStore = new MemoryEventStore();
  const fsService = new FilesystemService(fsIndex, eventStore);
  fsIndex.upsertProject({
    project_id: "git_pair",
    name: "pair-proj",
    root_path: "C:/tmp/pair-proj",
    vcs: "git",
    fingerprint: "f".repeat(40),
    wsl: false,
  });
  const keys = generateKxKeypair();
  const devices = new DeviceStore(":memory:");
  const pairing = new PairingCoordinator({
    keys,
    devices,
    machineId: "mch_pair",
    machineName: "pair-host",
  });
  deps = {
    machineId: "mch_pair",
    machineName: "pair-host",
    localToken: LOCAL_TOKEN,
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
  const { app } = await buildServer(deps);
  closers.push(() => app.close());
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

const api = (method: string, url: string) =>
  fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
  }).then((r) => r.json() as Promise<Record<string, unknown>>);

function appendFsEvent(relativePath: string): void {
  const stored = deps.eventStore.append(fsStream("git_pair"), [
    {
      event_id: newEventId(),
      type: FileChanged.type,
      ts: nowIso(),
      payload: {
        project_id: "git_pair",
        change: "create",
        relative_path: relativePath,
        kind: "file",
        old_path: null,
      },
    },
  ]);
  deps.fsService.emitter.emit("events", stored);
}

describe("S2 gate: pair → E2EE session → live push → drop → replay resume", () => {
  test("full phone-simulator flow", async () => {
    // 1. dashboard starts pairing, gets QR payload
    const started = (await api("POST", "/api/pairing/start")) as {
      code: string;
      qr_payload: { kx_pub: string; machine_id: string; addrs: string[] };
    };
    expect(started.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(started.qr_payload.machine_id).toBe("mch_pair");

    // 2. phone scans QR → pairs with code + its kx keypair
    const phoneKeys = generateKxKeypair();
    const controllerPub = fromB64(started.qr_payload.kx_pub);
    let pendingFingerprint = "";
    const grantPromise = pairWithController({
      url: `ws://127.0.0.1:${port}/pair`,
      code: started.code,
      deviceName: "Sim iPhone",
      keypair: phoneKeys,
      controllerKxPub: controllerPub,
      onPending: (fp) => {
        pendingFingerprint = fp;
      },
    });

    // 3. dashboard sees pending_confirm with matching emoji fingerprint, confirms
    await expect
      .poll(async () => ((await api("GET", "/api/pairing/status")) as { state: string }).state, {
        timeout: 5000,
      })
      .toBe("pending_confirm");
    const status = (await api("GET", "/api/pairing/status")) as {
      fingerprint: string;
      device_name: string;
    };
    expect(status.device_name).toBe("Sim iPhone");
    expect(status.fingerprint).toBe(emojiFingerprint(controllerPub, phoneKeys.publicKey));
    await api("POST", "/api/pairing/confirm");

    // 4. phone receives the sealed grant (authenticated by the controller key from the QR)
    const grant = await grantPromise;
    expect(grant.machine_id).toBe("mch_pair");
    expect(pendingFingerprint).toBe(status.fingerprint);
    expect(deps.devices.list()).toHaveLength(1);

    // 5. connect with the granted token + E2EE — commands work over the encrypted channel
    const client = new ControllerClient({
      url: `ws://127.0.0.1:${port}/ws`,
      token: grant.token,
      deviceId: grant.device_id,
      keys: { keypair: phoneKeys, controllerKxPub: fromB64(grant.controller_kx_pub) },
      backoff: { baseMs: 50, capMs: 250 },
    });
    closers.push(() => client.close());
    await client.connect();
    expect(client.isSecure).toBe(true);

    const projects = await client.command(ProjectList, {});
    expect(projects.projects).toHaveLength(1);
    expect(projects.projects[0]?.name).toBe("pair-proj");

    // 6. subscribe → live event arrives encrypted, in order
    const received: Array<{ seq: number; path: string }> = [];
    client.events.on("event", (msg: KnownMessage) => {
      if (msg.type === "file.changed") {
        received.push({ seq: msg.seq, path: msg.payload.relative_path });
      }
    });
    client.subscribe(fsStream("git_pair"), 0);
    appendFsEvent("src/live-one.ts");
    await expect.poll(() => received.length, { timeout: 5000 }).toBe(1);
    expect(received[0]).toEqual({ seq: 1, path: "src/live-one.ts" });

    // 7. hard-drop the socket; miss an event while down; reconnect must replay it exactly once
    client.dropForTesting();
    appendFsEvent("src/missed-while-down.ts");
    await expect.poll(() => received.length, { timeout: 10_000 }).toBe(2);
    expect(received[1]).toEqual({ seq: 2, path: "src/missed-while-down.ts" });
    appendFsEvent("src/live-after-reconnect.ts");
    await expect.poll(() => received.length, { timeout: 5000 }).toBe(3);
    expect(received.map((r) => r.seq)).toEqual([1, 2, 3]); // ordered, no duplicates

    // 8. bad token cannot connect
    const badClient = new ControllerClient({
      url: `ws://127.0.0.1:${port}/ws`,
      token: "wrong-token-wrong-token-wrong-token-wrong",
      deviceId: "dev_evil",
      backoff: { baseMs: 50, capMs: 100 },
    });
    await expect(badClient.connect(1500)).rejects.toThrow();
    badClient.close();
  }, 30_000);

  test("wrong pairing code locks the session after 5 attempts", async () => {
    const started = (await api("POST", "/api/pairing/start")) as {
      code: string;
      qr_payload: { kx_pub: string };
    };
    const phoneKeys = generateKxKeypair();
    const controllerPub = fromB64(started.qr_payload.kx_pub);
    for (let i = 0; i < 5; i++) {
      await expect(
        pairWithController({
          url: `ws://127.0.0.1:${port}/pair`,
          code: "WRONGGGG",
          deviceName: "Evil Phone",
          keypair: phoneKeys,
          controllerKxPub: controllerPub,
          timeoutMs: 3000,
        }),
      ).rejects.toThrow(/wrong pairing code|too many attempts/);
    }
    expect(((await api("GET", "/api/pairing/status")) as { state: string }).state).toBe("locked");
    // even the correct code is refused after lockout
    await expect(
      pairWithController({
        url: `ws://127.0.0.1:${port}/pair`,
        code: started.code,
        deviceName: "Evil Phone",
        keypair: phoneKeys,
        controllerKxPub: controllerPub,
        timeoutMs: 3000,
      }),
    ).rejects.toThrow();
  }, 30_000);
});

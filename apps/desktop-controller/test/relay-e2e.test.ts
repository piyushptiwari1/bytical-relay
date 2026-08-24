import type { AddressInfo } from "node:net";
import { MemoryEventStore } from "@rdc/event-store";
import { FilesystemService, FsIndex } from "@rdc/filesystem";
import { GitService } from "@rdc/git";
import { FileChanged, fsStream, type KnownMessage, ProjectList } from "@rdc/protocol";
import { buildRelay } from "@rdc/relay";
import { generateKxKeypair, hashToken, toB64 } from "@rdc/security";
import { newEventId, nowIso } from "@rdc/shared";
import { TerminalManager } from "@rdc/terminal";
import { ControllerClient } from "@rdc/transport";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AgentManager } from "../src/agent-manager.ts";
import { DeviceStore } from "../src/device-store.ts";
import { EditorRegistry } from "../src/editors.ts";
import { KeepAwake } from "../src/keep-awake.ts";
import { HealthMonitor } from "../src/machine-health.ts";
import { PairingCoordinator } from "../src/pairing-coordinator.ts";
import { RelayClient } from "../src/relay-client.ts";
import { buildServer, type ServerDeps } from "../src/server.ts";

const RELAY_TOKEN = "relay-token-abcdef0123456789";
const DEVICE_TOKEN = "device-token-abcdef0123456789abcdef";
const MACHINE = "mch_relay";

let deps: ServerDeps;
let relayPort: number;
let forwarded: string[] = [];
const closers: Array<() => Promise<unknown> | unknown> = [];

beforeAll(async () => {
  const fsIndex = new FsIndex(":memory:");
  const eventStore = new MemoryEventStore();
  const fsService = new FilesystemService(fsIndex, eventStore);
  fsIndex.upsertProject({
    project_id: "git_relayproj",
    name: "relay-proj",
    root_path: "C:/tmp/relay-proj",
    vcs: "git",
    fingerprint: "e".repeat(40),
    wsl: false,
  });
  const keys = generateKxKeypair();
  const devices = new DeviceStore(":memory:");
  deps = {
    machineId: MACHINE,
    machineName: "relay-host",
    localToken: "local-token-0123456789abcdef0123456789abcdef",
    keys,
    devices,
    pairing: new PairingCoordinator({ keys, devices, machineId: MACHINE, machineName: "rh" }),
    fsService,
    fsIndex,
    eventStore,
    health: new HealthMonitor(),
    keepAwake: new KeepAwake({ supported: true, activate() {}, deactivate() {} }),
    git: new GitService(),
    editors: new EditorRegistry(),
    terminals: new TerminalManager(),
    agents: new AgentManager({ eventStore, fsIndex }, []),
    relay: { url: "ws://placeholder", token: RELAY_TOKEN },
  };

  // pre-paired phone (pairing flow itself is covered by pairing-e2e)
  const phone = phoneIdentity();
  devices.add({
    device_id: "dev_relayphone",
    name: "Relay Phone",
    kx_pub: toB64(phone.keys.publicKey),
    token_hash: hashToken(DEVICE_TOKEN),
    scopes: ["*"],
  });

  const relay = await buildRelay({
    token: RELAY_TOKEN,
    onForward: (_direction, data) => {
      forwarded.push(typeof data === "string" ? data : data.toString("latin1"));
    },
  });
  closers.push(() => relay.close());
  await relay.listen({ port: 0, host: "127.0.0.1" });
  relayPort = (relay.server.address() as AddressInfo).port;

  const { app, attachProtocolSocket } = await buildServer(deps);
  closers.push(() => app.close());

  const relayClient = new RelayClient({
    url: `ws://127.0.0.1:${relayPort}`,
    relayToken: RELAY_TOKEN,
    machineId: MACHINE,
    devices,
    attach: (socket, device) => attachProtocolSocket(socket, device ?? undefined),
  });
  closers.push(() => relayClient.stop());
  relayClient.start();
  const start = Date.now();
  while (!relayClient.connected()) {
    if (Date.now() - start > 5000) throw new Error("relay client never connected");
    await new Promise((r) => setTimeout(r, 50));
  }
});

afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

// stable phone identity shared between beforeAll and tests
let cachedPhone: { keys: ReturnType<typeof generateKxKeypair> } | null = null;
function phoneIdentity() {
  cachedPhone ??= { keys: generateKxKeypair() };
  return cachedPhone;
}

function appendFsEvent(relativePath: string): void {
  const stored = deps.eventStore.append(fsStream("git_relayproj"), [
    {
      event_id: newEventId(),
      type: FileChanged.type,
      ts: nowIso(),
      payload: {
        project_id: "git_relayproj",
        change: "create",
        relative_path: relativePath,
        kind: "file",
        old_path: null,
      },
    },
  ]);
  deps.fsService.emitter.emit("events", stored);
}

describe("S7 gate: phone ↔ relay ↔ laptop, E2EE preserved", () => {
  test("paired device connects through relay: commands, live push, machine.status relay info", async () => {
    const phone = phoneIdentity();
    const client = new ControllerClient({
      url: `ws://127.0.0.1:${relayPort}/tunnel?role=phone&machine=${MACHINE}&rt=${RELAY_TOKEN}`,
      token: DEVICE_TOKEN,
      deviceId: "dev_relayphone",
      keys: { keypair: phone.keys, controllerKxPub: deps.keys.publicKey },
      backoff: { baseMs: 50, capMs: 250 },
    });
    closers.push(() => client.close());
    await client.connect();
    expect(client.isSecure).toBe(true);

    forwarded = []; // only inspect post-handshake traffic for the zero-knowledge check

    const projects = await client.command(ProjectList, {});
    expect(projects.projects).toHaveLength(1);
    expect(projects.projects[0]?.name).toBe("relay-proj");

    // live push flows through the tunnel
    const received: string[] = [];
    client.events.on("event", (msg: KnownMessage) => {
      if (msg.type === "file.changed") received.push(msg.payload.relative_path);
    });
    client.subscribe(fsStream("git_relayproj"), 0);
    appendFsEvent("src/via-relay.ts");
    await expect.poll(() => received.length, { timeout: 5000 }).toBe(1);

    // zero-knowledge: the relay saw only ciphertext for all of the above
    expect(forwarded.length).toBeGreaterThan(0);
    for (const frame of forwarded) {
      expect(frame).not.toContain("relay-proj");
      expect(frame).not.toContain("project.list");
      expect(frame).not.toContain("via-relay.ts");
    }
  });

  test("unpaired token is rejected at the laptop, not the relay", async () => {
    const stranger = new ControllerClient({
      url: `ws://127.0.0.1:${relayPort}/tunnel?role=phone&machine=${MACHINE}&rt=${RELAY_TOKEN}`,
      token: "not-a-paired-device-token-000000",
      deviceId: "dev_evil",
      backoff: { baseMs: 50, capMs: 100 },
    });
    await expect(stranger.connect(1500)).rejects.toThrow();
    stranger.close();
  });

  test("wrong relay token cannot even reach the machine", async () => {
    const blocked = new ControllerClient({
      url: `ws://127.0.0.1:${relayPort}/tunnel?role=phone&machine=${MACHINE}&rt=WRONG`,
      token: DEVICE_TOKEN,
      deviceId: "dev_relayphone",
      backoff: { baseMs: 50, capMs: 100 },
    });
    await expect(blocked.connect(1500)).rejects.toThrow();
    blocked.close();
  });
});

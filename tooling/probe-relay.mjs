// Live relay suite: pairs a probe device with the local controller (auto-confirm
// via dashboard API), then connects THROUGH the relay tunnel with full E2EE and
// exercises commands. Requires: controller running with relay configured.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectList,
  SysPing,
  TerminalCreate,
  TerminalKill,
  TerminalSnapshotCmd,
  TerminalWrite,
} from "@rdc/protocol";
import { fromB64, generateKxKeypair, toB64 } from "@rdc/security";
import { ControllerClient, pairWithController } from "@rdc/transport";
import { localToken, sleep } from "./probe-lib.mjs";

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".probe-device.json");

async function api(port, method, url) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { authorization: `Bearer ${localToken()}` },
  });
  if (!response.ok) throw new Error(`${method} ${url} → ${response.status}`);
  return response.json();
}

/** Load or create a paired probe-device identity against the local controller. */
export async function ensureProbeDevice(port) {
  if (existsSync(STATE_FILE)) {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return saved;
  }
  const started = await api(port, "POST", "/api/pairing/start");
  const keypair = generateKxKeypair();
  const grantPromise = pairWithController({
    url: `ws://127.0.0.1:${port}/pair`,
    code: started.code,
    deviceName: "probe-device",
    keypair,
    controllerKxPub: fromB64(started.qr_payload.kx_pub),
  });
  // auto-confirm as the dashboard would
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const status = await api(port, "GET", "/api/pairing/status");
    if (status.state === "pending_confirm") break;
  }
  await api(port, "POST", "/api/pairing/confirm");
  const grant = await grantPromise;
  const state = {
    machine_id: grant.machine_id,
    device_id: grant.device_id,
    token: grant.token,
    controller_kx_pub: grant.controller_kx_pub,
    kx_pub: toB64(keypair.publicKey),
    kx_priv: toB64(keypair.privateKey),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

/** The relay suite body — registered by tooling/probe.mjs. */
export async function relaySuite(t, { port, relayUrl, relayToken }) {
  let device;
  await t.expect(
    "RL1",
    "relay /healthz reachable over the internet",
    async () => {
      const httpUrl = relayUrl.replace(/^ws/, "http").replace(/\/$/, "");
      const response = await fetch(`${httpUrl}/healthz`);
      const body = await response.json();
      if (!body.ok) throw new Error("healthz not ok");
      return `machines=${body.machines} channels=${body.channels}`;
    },
    { fatal: true },
  );
  await t.expect(
    "RL2",
    "probe device paired with controller",
    async () => {
      device = await ensureProbeDevice(port);
      return device.device_id;
    },
    { fatal: true },
  );

  const client = new ControllerClient({
    url: `${relayUrl.replace(/\/$/, "")}/tunnel?role=phone&machine=${encodeURIComponent(device.machine_id)}&rt=${encodeURIComponent(relayToken)}`,
    token: device.token,
    deviceId: device.device_id,
    keys: {
      keypair: { publicKey: fromB64(device.kx_pub), privateKey: fromB64(device.kx_priv) },
      controllerKxPub: fromB64(device.controller_kx_pub),
    },
    backoff: { baseMs: 500, capMs: 2000 },
  });
  try {
    await t.expect(
      "RL3",
      "E2EE session established through relay",
      async () => {
        await client.connect(15_000);
        if (!client.isSecure) throw new Error("session not encrypted");
        const { pong } = await client.command(SysPing, {});
        return `secure, pong ${pong}`;
      },
      { fatal: true },
    );
    await t.expect("RL4", "commands over relay: project.list", async () => {
      const { projects } = await client.command(ProjectList, {});
      if (projects.length === 0) throw new Error("no projects");
      return `${projects.length} projects`;
    });
    await t.expect("RL5", "terminal round-trip over relay", async () => {
      const marker = `relay_ok_${Date.now() % 100000}`;
      const { terminal } = await client.command(TerminalCreate, { shell: "cmd" });
      await sleep(1500);
      await client.command(TerminalWrite, {
        terminal_id: terminal.terminal_id,
        data: `echo ${marker}\r`,
      });
      await sleep(1500);
      const snapshot = await client.command(TerminalSnapshotCmd, {
        terminal_id: terminal.terminal_id,
      });
      const text = snapshot.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n");
      await client.command(TerminalKill, { terminal_id: terminal.terminal_id });
      if (!text.includes(marker)) throw new Error("echo not visible via relay");
      return `snapshot ${snapshot.lines.length} lines`;
    });
  } finally {
    client.close();
  }
}

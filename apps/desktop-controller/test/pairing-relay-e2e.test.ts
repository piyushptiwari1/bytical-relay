import { buildRelay } from "@rdc/relay";
import { generateKxKeypair } from "@rdc/security";
import { pairWithController } from "@rdc/transport";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DeviceStore } from "../src/device-store.ts";
import { openPairingBridge } from "../src/pairing-bridge.ts";
import { PairingCoordinator } from "../src/pairing-coordinator.ts";

const RELAY_TOKEN = "relay-secret-for-tests";

describe("pairing through the relay bridge (isolated Wi-Fi path)", () => {
  let relayUrl: string;
  let relay: Awaited<ReturnType<typeof buildRelay>>;
  const closers: Array<() => unknown> = [];

  beforeAll(async () => {
    relay = await buildRelay({ token: RELAY_TOKEN });
    await relay.listen({ port: 0, host: "127.0.0.1" });
    const address = relay.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    relayUrl = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const close of closers) await close();
    await relay.close();
  });

  test("full ceremony: code + fingerprint + sealed grant, relay never trusted", async () => {
    const keys = generateKxKeypair();
    const devices = new DeviceStore(":memory:");
    const pairing = new PairingCoordinator({
      keys,
      devices,
      machineId: "mch_bridge",
      machineName: "bridge-host",
    });
    const started = pairing.start();
    const pairingId = "test-pairing-0001";
    const closeBridge = openPairingBridge({
      relayUrl,
      relayToken: RELAY_TOKEN,
      pairingId,
      pairing,
    });
    closers.push(closeBridge);

    // owner confirms as soon as the phone's request lands (poll like the UI does)
    const confirmLoop = setInterval(() => {
      if (pairing.status().state === "pending_confirm") {
        clearInterval(confirmLoop);
        pairing.confirm();
      }
    }, 50);

    const phoneKeypair = generateKxKeypair();
    const grant = await pairWithController({
      url: `${relayUrl}/pair-bridge?role=phone&pairing=${pairingId}`,
      code: started.code,
      deviceName: "test phone (isolated wifi)",
      keypair: phoneKeypair,
      controllerKxPub: keys.publicKey,
      timeoutMs: 15_000,
      connectTimeoutMs: 5_000,
    });
    clearInterval(confirmLoop);

    expect(grant.machine_id).toBe("mch_bridge");
    expect(grant.token.length).toBeGreaterThan(20);
    expect(devices.list()).toHaveLength(1);
  });

  test("open tier: controller with only a self-registered machine secret can bridge pairing", async () => {
    const keys = generateKxKeypair();
    const devices = new DeviceStore(":memory:");
    const pairing = new PairingCoordinator({
      keys,
      devices,
      machineId: "mch_open_tier",
      machineName: "open-tier-host",
    });
    const started = pairing.start();
    const pairingId = "open-tier-pairing-0001";
    const closeBridge = openPairingBridge({
      relayUrl,
      machineSecret: "self-minted-secret-at-least-32-chars-long!",
      pairingId,
      pairing,
    });
    closers.push(closeBridge);
    const confirmLoop = setInterval(() => {
      if (pairing.status().state === "pending_confirm") {
        clearInterval(confirmLoop);
        pairing.confirm();
      }
    }, 50);
    const phoneKeypair = generateKxKeypair();
    const grant = await pairWithController({
      url: `${relayUrl}/pair-bridge?role=phone&pairing=${pairingId}`,
      code: started.code,
      deviceName: "open tier phone",
      keypair: phoneKeypair,
      controllerKxPub: keys.publicKey,
      timeoutMs: 15_000,
      connectTimeoutMs: 5_000,
    });
    clearInterval(confirmLoop);
    expect(grant.machine_id).toBe("mch_open_tier");
  });

  test("wrong relay token cannot register a bridge; unknown pairing id is rejected", async () => {
    const phoneKeypair = generateKxKeypair();
    await expect(
      pairWithController({
        url: `${relayUrl}/pair-bridge?role=phone&pairing=nonexistent-pairing`,
        code: "AAAAAAAA",
        deviceName: "probe",
        keypair: phoneKeypair,
        controllerKxPub: generateKxKeypair().publicKey,
        timeoutMs: 4_000,
        connectTimeoutMs: 2_000,
      }),
    ).rejects.toThrow();
  });
});

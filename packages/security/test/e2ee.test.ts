import { beforeAll, describe, expect, test } from "vitest";
import {
  emojiFingerprint,
  fromB64,
  generateKxKeypair,
  initSodium,
  openBox,
  PairingSession,
  SecureChannel,
  sealBox,
  toB64,
} from "../src/index.ts";

beforeAll(async () => {
  await initSodium();
});

describe("SecureChannel (crypto_kx + secretstream)", () => {
  function establishedPair(): { client: SecureChannel; server: SecureChannel } {
    const serverKp = generateKxKeypair();
    const clientKp = generateKxKeypair();
    const server = new SecureChannel("server", serverKp, clientKp.publicKey);
    const client = new SecureChannel("client", clientKp, serverKp.publicKey);
    client.acceptHeader(server.createHeader());
    server.acceptHeader(client.createHeader());
    return { client, server };
  }

  test("bidirectional encrypt/decrypt round-trip", () => {
    const { client, server } = establishedPair();
    expect(client.ready && server.ready).toBe(true);
    const toServer = new TextEncoder().encode(JSON.stringify({ type: "project.list" }));
    const fromClient = server.decrypt(client.encrypt(toServer));
    expect(new TextDecoder().decode(fromClient)).toContain("project.list");
    const toClient = new TextEncoder().encode("push-event");
    expect(new TextDecoder().decode(client.decrypt(server.encrypt(toClient)))).toBe("push-event");
  });

  test("tampered ciphertext throws; wrong peer cannot decrypt", () => {
    const { client, server } = establishedPair();
    const cipher = client.encrypt(new TextEncoder().encode("secret"));
    cipher[cipher.length - 1] = (cipher[cipher.length - 1] as number) ^ 0xff;
    expect(() => server.decrypt(cipher)).toThrow();

    const eveKp = generateKxKeypair();
    const serverKp = generateKxKeypair();
    const clientKp = generateKxKeypair();
    const realServer = new SecureChannel("server", serverKp, clientKp.publicKey);
    const eve = new SecureChannel("client", eveKp, serverKp.publicKey);
    const realClient = new SecureChannel("client", clientKp, serverKp.publicKey);
    realClient.acceptHeader(realServer.createHeader());
    realServer.acceptHeader(realClient.createHeader());
    const intercepted = realClient.encrypt(new TextEncoder().encode("top secret"));
    eve.acceptHeader(realServer.createHeader());
    expect(() => eve.decrypt(intercepted)).toThrow();
  });

  test("sealBox/openBox authenticated grant delivery + b64 helpers", () => {
    const serverKp = generateKxKeypair();
    const clientKp = generateKxKeypair();
    const grant = new TextEncoder().encode(JSON.stringify({ token: "tok_x" }));
    const sealed = sealBox(grant, clientKp.publicKey, serverKp.privateKey);
    const opened = openBox(sealed, serverKp.publicKey, clientKp.privateKey);
    expect(new TextDecoder().decode(opened)).toContain("tok_x");
    const mallory = generateKxKeypair();
    expect(() => openBox(sealed, mallory.publicKey, clientKp.privateKey)).toThrow();
    expect(fromB64(toB64(grant))).toEqual(grant);
  });

  test("emoji fingerprint is deterministic and key-dependent", () => {
    const a = generateKxKeypair();
    const b = generateKxKeypair();
    expect(emojiFingerprint(a.publicKey, b.publicKey)).toBe(
      emojiFingerprint(a.publicKey, b.publicKey),
    );
    expect(emojiFingerprint(a.publicKey, b.publicKey)).not.toBe(
      emojiFingerprint(b.publicKey, a.publicKey),
    );
    expect(emojiFingerprint(a.publicKey, b.publicKey).split(" ")).toHaveLength(4);
  });
});

describe("PairingSession", () => {
  const device = { deviceName: "Test iPhone", deviceKxPubB64: "cHVi" };

  test("happy path: waiting → pending_confirm → granted", () => {
    const session = new PairingSession(1000, 60_000, "ABCD2345");
    expect(session.state(1001)).toBe("waiting");
    expect(session.attempt("ABCD2345", device, 1002)).toBe("pending_confirm");
    expect(session.pendingDevice?.deviceName).toBe("Test iPhone");
    expect(session.confirm(1003)).toBe(true);
    expect(session.state(1004)).toBe("granted");
  });

  test("expiry, wrong-code lockout after 5 attempts, cancel", () => {
    const expired = new PairingSession(1000, 60_000, "ABCD2345");
    expect(expired.attempt("ABCD2345", device, 61_001)).toBe("expired");

    const locked = new PairingSession(1000, 60_000, "ABCD2345");
    for (let i = 0; i < 4; i++) expect(locked.attempt("WRONG234", device, 2000)).toBe("mismatch");
    expect(locked.attempt("WRONG234", device, 2000)).toBe("locked");
    expect(locked.attempt("ABCD2345", device, 2000)).toBe("locked"); // right code after lockout still refused

    const cancelled = new PairingSession(1000, 60_000, "ABCD2345");
    cancelled.cancel();
    expect(cancelled.state(1001)).toBe("cancelled");
    expect(cancelled.confirm(1002)).toBe(false);
  });
});

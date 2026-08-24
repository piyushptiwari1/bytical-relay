import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { buildRelay } from "../src/server.ts";

const TOKEN = "test-relay-token-0123456789";

function once<T>(ws: WebSocket, event: string): Promise<T> {
  return new Promise((resolve) => ws.once(event, (arg: T) => resolve(arg)));
}
function nextMessage(ws: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) =>
    ws.once("message", (data: Buffer, isBinary: boolean) => resolve({ data, isBinary })),
  );
}
const opened = (ws: WebSocket) => once(ws, "open");

describe("relay tunnel", () => {
  let port: number;
  let app: Awaited<ReturnType<typeof buildRelay>>;

  beforeAll(async () => {
    app = await buildRelay({ token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app.close();
  });

  const url = (params: string) => `ws://127.0.0.1:${port}/tunnel?${params}`;

  test("wrong relay token → 4401; phone with no machine online → 4404", async () => {
    const bad = new WebSocket(url("role=controller&machine=m1&rt=nope"));
    expect((await once<{ code?: number } | number>(bad, "close")) as number).toBe(4401);

    const phone = new WebSocket(url(`role=phone&machine=ghost&rt=${TOKEN}&token=d`));
    expect((await once<number>(phone, "close")) as number).toBe(4404);
  });

  test("full round-trip: open envelope, text + binary both ways, close fan-out", async () => {
    const laptop = new WebSocket(url(`role=controller&machine=m2&rt=${TOKEN}`));
    await opened(laptop);

    const phone = new WebSocket(url(`role=phone&machine=m2&rt=${TOKEN}&token=device-tok`));
    const openEnvelope = JSON.parse((await nextMessage(laptop)).data.toString());
    expect(openEnvelope.t).toBe("open");
    expect(openEnvelope.token).toBe("device-tok");
    const ch = openEnvelope.ch as string;

    // phone → laptop text
    phone.send('{"hello":true}');
    const wrapped = JSON.parse((await nextMessage(laptop)).data.toString());
    expect(wrapped).toMatchObject({ t: "msg", ch, data: '{"hello":true}' });

    // laptop → phone text
    laptop.send(JSON.stringify({ t: "msg", ch, data: "pong!" }));
    const textDown = await nextMessage(phone);
    expect(textDown.data.toString()).toBe("pong!");

    // phone → laptop binary (opaque ciphertext in production)
    const cipher = Buffer.from([1, 2, 3, 250, 251]);
    phone.send(cipher);
    const wrappedBin = JSON.parse((await nextMessage(laptop)).data.toString());
    expect(wrappedBin.bin).toBe(true);
    expect(Buffer.from(wrappedBin.data, "base64")).toEqual(cipher);

    // laptop → phone binary
    laptop.send(JSON.stringify({ t: "msg", ch, bin: true, data: cipher.toString("base64") }));
    const binDown = await nextMessage(phone);
    expect(binDown.isBinary).toBe(true);
    expect(binDown.data).toEqual(cipher);

    // laptop drops → phone force-closed with 4410
    laptop.close();
    expect(await once<number>(phone, "close")).toBe(4410);
  });

  test("machine close envelope closes just that phone; healthz counts", async () => {
    const laptop = new WebSocket(url(`role=controller&machine=m3&rt=${TOKEN}`));
    await opened(laptop);
    const phone = new WebSocket(url(`role=phone&machine=m3&rt=${TOKEN}&token=t`));
    const { ch } = JSON.parse((await nextMessage(laptop)).data.toString());

    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.json()).toMatchObject({ ok: true, machines: expect.any(Number) });

    laptop.send(JSON.stringify({ t: "close", ch }));
    expect(await once<number>(phone, "close")).toBe(1000);
    laptop.close();
  });
});

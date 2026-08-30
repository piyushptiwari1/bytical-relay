import { describe, expect, test } from "vitest";
import { ControllerClient } from "../src/client.ts";
import type { WebSocketLike } from "../src/websocket.ts";

class SilentSocket implements WebSocketLike {
  binaryType = "";
  readyState = 0;
  #listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  send(_data: string | Uint8Array): void {}

  close(): void {
    for (const listener of this.#listeners.get("close") ?? []) listener({});
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners as Array<(event: { data?: unknown }) => void>);
  }
}

describe("ControllerClient connection URLs", () => {
  test("suppresses the controller token when a relay URL already has a ticket", async () => {
    const urls: string[] = [];
    const webSocketFactory = (url: string) => {
      urls.push(url);
      return new SilentSocket();
    };
    const token = "paired-controller-token";
    const relay = new ControllerClient({
      url: "ws://relay.example/tunnel?role=phone&machine=mch_1&ticket=signed-ticket",
      token,
      sendTokenInUrl: false,
      deviceId: "dev_1",
      webSocketFactory,
    });
    await expect(relay.connect(1)).rejects.toThrow("connect timeout");

    const direct = new ControllerClient({
      url: "ws://127.0.0.1:8347/ws",
      token,
      deviceId: "dev_1",
      webSocketFactory,
    });
    await expect(direct.connect(1)).rejects.toThrow("connect timeout");

    expect(urls[0]).toContain("ticket=signed-ticket");
    expect(urls[0]).not.toContain(token);
    expect(urls[0]).not.toContain("&token=");
    expect(urls[1]).toContain(`token=${token}`);
  });
});

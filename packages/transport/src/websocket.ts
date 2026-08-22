/** Minimal isomorphic WebSocket surface (browser/RN/undici all satisfy it). */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

interface WebSocketCtor {
  new (url: string): WebSocketLike;
}

export const defaultWebSocketFactory: WebSocketFactory = (url) => {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!ctor) throw new Error("no global WebSocket — pass webSocketFactory");
  return new ctor(url);
};

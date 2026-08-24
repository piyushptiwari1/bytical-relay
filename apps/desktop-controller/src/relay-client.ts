import { hashToken } from "@rdc/security";
import WebSocket from "ws";
import type { DeviceStore } from "./device-store.ts";
import type { WsLike } from "./server.ts";

export interface RelayClientDeps {
  url: string; // ws(s)://host:port — /tunnel appended here
  relayToken: string;
  machineId: string;
  devices: DeviceStore;
  attach: (socket: WsLike, device: ReturnType<DeviceStore["findByTokenHash"]>) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface Envelope {
  t?: string;
  ch?: string;
  bin?: boolean;
  data?: string;
  token?: string;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * Dials OUT to the relay and turns each relay channel into a virtual protocol
 * socket, so remote phones flow through the exact same pipeline (auth → hello
 * → mandatory E2EE) as direct LAN connections. Only paired devices are
 * accepted over the relay — the local token path stays LAN-only.
 */
export class RelayClient {
  readonly #deps: RelayClientDeps;
  #ws: WebSocket | null = null;
  #channels = new Map<string, VirtualSocket>();
  #backoffMs = RECONNECT_MIN_MS;
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: RelayClientDeps) {
    this.#deps = deps;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#closeAllChannels();
    this.#ws?.close();
    this.#ws = null;
  }

  connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  #connect(): void {
    const url = `${this.#deps.url.replace(/\/$/, "")}/tunnel?role=controller&machine=${encodeURIComponent(
      this.#deps.machineId,
    )}&rt=${encodeURIComponent(this.#deps.relayToken)}`;
    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.on("open", () => {
      this.#backoffMs = RECONNECT_MIN_MS;
      this.#deps.log?.("relay connected", { url: this.#deps.url });
    });
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg: Envelope;
      try {
        msg = JSON.parse(raw.toString()) as Envelope;
      } catch {
        return;
      }
      if (typeof msg.ch !== "string") return;
      if (msg.t === "open") this.#openChannel(msg.ch, msg.token ?? "");
      else if (msg.t === "msg") this.#channels.get(msg.ch)?.receive(msg);
      else if (msg.t === "close") this.#dropChannel(msg.ch);
    });
    ws.on("close", () => {
      if (this.#ws === ws) this.#ws = null;
      this.#closeAllChannels();
      this.#scheduleReconnect();
    });
    ws.on("error", () => {
      // close follows; reconnect handled there
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    this.#deps.log?.("relay disconnected — retrying", { in_ms: this.#backoffMs });
    this.#timer = setTimeout(() => this.#connect(), this.#backoffMs);
    this.#timer.unref?.();
    this.#backoffMs = Math.min(this.#backoffMs * 2, RECONNECT_MAX_MS);
  }

  #openChannel(ch: string, deviceToken: string): void {
    // relay-side connections MUST be paired devices (E2EE enforced by attach)
    const device = this.#deps.devices.findByTokenHash(hashToken(deviceToken));
    if (!device) {
      this.#send({ t: "close", ch });
      return;
    }
    const socket = new VirtualSocket(ch, (envelope) => this.#send(envelope));
    this.#channels.set(ch, socket);
    this.#deps.attach(socket, device);
  }

  #dropChannel(ch: string): void {
    const socket = this.#channels.get(ch);
    this.#channels.delete(ch);
    socket?.emitClose();
  }

  #closeAllChannels(): void {
    for (const [, socket] of this.#channels) socket.emitClose();
    this.#channels.clear();
  }

  #send(envelope: Envelope): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(envelope));
  }
}

/** One relay channel presented to the server pipeline as a normal socket. */
class VirtualSocket implements WsLike {
  readonly #ch: string;
  readonly #sendEnvelope: (envelope: Envelope) => void;
  #messageHandlers: Array<(data: Buffer, isBinary: boolean) => void> = [];
  #closeHandlers: Array<() => void> = [];
  #closed = false;

  constructor(ch: string, sendEnvelope: (envelope: Envelope) => void) {
    this.#ch = ch;
    this.#sendEnvelope = sendEnvelope;
  }

  send(data: string | Uint8Array): void {
    if (this.#closed) return;
    if (typeof data === "string") {
      this.#sendEnvelope({ t: "msg", ch: this.#ch, data });
    } else {
      this.#sendEnvelope({
        t: "msg",
        ch: this.#ch,
        bin: true,
        data: Buffer.from(data).toString("base64"),
      });
    }
  }

  close(_code?: number, _reason?: string): void {
    if (this.#closed) return;
    this.#sendEnvelope({ t: "close", ch: this.#ch });
    this.emitClose();
  }

  on(event: "message", cb: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "close", cb: () => void): void;
  on(
    event: "message" | "close",
    cb: ((data: Buffer, isBinary: boolean) => void) | (() => void),
  ): void {
    if (event === "message")
      this.#messageHandlers.push(cb as (data: Buffer, isBinary: boolean) => void);
    else this.#closeHandlers.push(cb as () => void);
  }

  receive(msg: Envelope): void {
    if (this.#closed || typeof msg.data !== "string") return;
    const buffer = msg.bin ? Buffer.from(msg.data, "base64") : Buffer.from(msg.data, "utf8");
    for (const handler of this.#messageHandlers) handler(buffer, msg.bin === true);
  }

  emitClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of this.#closeHandlers) handler();
  }
}

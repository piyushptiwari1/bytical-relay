import {
  decodeFrame,
  encodeFrame,
  eventEnvelopeFromRecord,
  FrameKind,
  Hello,
  type KnownMessage,
  parseInbound,
  SUPPORTED_VERSIONS,
  SyncReplay,
  SyncSubscribe,
  SysPing,
} from "@rdc/protocol";
import { type KxKeypair, SecureChannel } from "@rdc/security/client";
import { type BackoffOptions, nextDelayMs, TypedEmitter } from "@rdc/shared";
import { OrderedStreamBuffer } from "./ordered.ts";
import { defaultWebSocketFactory, type WebSocketFactory, type WebSocketLike } from "./websocket.ts";

export interface ClientKeys {
  keypair: KxKeypair;
  controllerKxPub: Uint8Array;
}

export interface ControllerClientOptions {
  /** ws://host:port/ws */
  url: string;
  token: string;
  /** Relay connections use a signed ticket in the URL and must not forward this controller token. */
  sendTokenInUrl?: boolean;
  deviceId: string;
  /** present for paired devices → E2EE is mandatory */
  keys?: ClientKeys;
  webSocketFactory?: WebSocketFactory;
  backoff?: BackoffOptions;
  heartbeatMs?: number;
  commandTimeoutMs?: number;
}

export type ClientState = "idle" | "connecting" | "ready" | "reconnecting" | "closed";

interface CommandDefLike<TArgs, TResult> {
  name: string;
  createRequest(args: TArgs, opts?: { command_id?: string }): { command_id: string };
  createOk(commandId: string, result: TResult, opts?: { duplicate?: boolean }): unknown;
}

interface PendingCommand {
  json: string;
  resolve: (value: unknown) => void;
  reject: (cause: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Reconnecting protocol client (IMPLEMENTATION-PLAN S2.1): hello/version
 * negotiation → optional E2EE handshake → typed commands with retry-safe
 * command_ids → subscriptions with cursor-based replay resume. Isomorphic:
 * Node 22+ (global WebSocket) today, React Native next.
 */
export class ControllerClient {
  readonly events = new TypedEmitter<{
    state: ClientState;
    event: KnownMessage;
    error: Error;
  }>();

  #ws: WebSocketLike | null = null;
  #state: ClientState = "idle";
  #secure: SecureChannel | null = null;
  #ownHeaderSent = false;
  #peerHeaderAccepted = false;
  #closedByUser = false;
  #prevDelay = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  readonly #pending = new Map<string, PendingCommand>();
  readonly #subs = new Map<string, OrderedStreamBuffer<KnownMessage>>();
  readonly #opts: Required<
    Pick<ControllerClientOptions, "backoff" | "heartbeatMs" | "commandTimeoutMs">
  > &
    ControllerClientOptions;

  constructor(options: ControllerClientOptions) {
    this.#opts = {
      backoff: { baseMs: 300, capMs: 15_000 },
      heartbeatMs: 15_000,
      commandTimeoutMs: 15_000,
      ...options,
    };
  }

  get state(): ClientState {
    return this.#state;
  }

  /** True once the E2EE handshake completed (always false for plaintext/local clients). */
  get isSecure(): boolean {
    return this.#secure !== null && this.#ownHeaderSent && this.#peerHeaderAccepted;
  }

  async connect(timeoutMs = 10_000): Promise<void> {
    this.#closedByUser = false;
    this.#openSocket();
    if (this.#state === "ready") return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.close();
        reject(new Error("connect timeout"));
      }, timeoutMs);
      const offState = this.events.on("state", (state) => {
        if (state === "ready") {
          cleanup();
          resolve();
        }
      });
      const offError = this.events.on("error", (cause) => {
        cleanup();
        this.close();
        reject(cause);
      });
      const cleanup = () => {
        clearTimeout(timer);
        offState();
        offError();
      };
    });
  }

  async command<TArgs, TResult>(
    def: CommandDefLike<TArgs, TResult>,
    args: TArgs,
    opts: { timeoutMs?: number; commandId?: string } = {},
  ): Promise<TResult> {
    const request = def.createRequest(
      args,
      opts.commandId ? { command_id: opts.commandId } : undefined,
    );
    const json = JSON.stringify(request);
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.command_id);
        reject(new Error(`command ${def.name} timed out`));
      }, opts.timeoutMs ?? this.#opts.commandTimeoutMs);
      this.#pending.set(request.command_id, {
        json,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      if (this.#state === "ready") this.#sendEnvelope(json);
      // not ready → resent automatically when the connection becomes ready
    });
  }

  /** Idempotent; on (re)connect the client re-subscribes and replays from the cursor. */
  subscribe(stream: string, fromSeq = 0): void {
    if (!this.#subs.has(stream)) this.#subs.set(stream, new OrderedStreamBuffer(fromSeq));
    if (this.#state === "ready") void this.#establishSubscription(stream);
  }

  cursorOf(stream: string): number {
    return this.#subs.get(stream)?.cursor ?? 0;
  }

  close(): void {
    this.#closedByUser = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#stopHeartbeat();
    this.#ws?.close(1000, "client closed");
    this.#ws = null;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("client closed"));
    }
    this.#pending.clear();
    this.#setState("closed");
  }

  /** Test hook: hard-drop the socket without marking a user close (forces reconnect). */
  dropForTesting(): void {
    this.#ws?.close(4000, "test drop");
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #setState(state: ClientState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.events.emit("state", state);
  }

  #openSocket(): void {
    this.#setState(this.#prevDelay > 0 ? "reconnecting" : "connecting");
    this.#ownHeaderSent = false;
    this.#peerHeaderAccepted = false;
    this.#secure = this.#opts.keys
      ? new SecureChannel("client", this.#opts.keys.keypair, this.#opts.keys.controllerKxPub)
      : null;
    const factory = this.#opts.webSocketFactory ?? defaultWebSocketFactory;
    const separator = this.#opts.url.includes("?") ? "&" : "?";
    const url =
      this.#opts.sendTokenInUrl === false
        ? this.#opts.url
        : `${this.#opts.url}${separator}token=${encodeURIComponent(this.#opts.token)}`;
    const ws = factory(url);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify(
          Hello.create({ protocol: SUPPORTED_VERSIONS, device_id: this.#opts.deviceId }),
        ),
      );
    });
    ws.addEventListener("message", (event) => this.#onMessage(event.data));
    ws.addEventListener("close", () => this.#onClose());
    ws.addEventListener("error", () => {
      // close event follows; reconnect logic lives there
    });
  }

  #onClose(): void {
    this.#stopHeartbeat();
    this.#ws = null;
    if (this.#closedByUser) {
      this.#setState("closed");
      return;
    }
    const delay = nextDelayMs(this.#prevDelay, this.#opts.backoff);
    this.#prevDelay = delay;
    this.#setState("reconnecting");
    this.#reconnectTimer = setTimeout(() => this.#openSocket(), delay);
  }

  #onMessage(data: unknown): void {
    if (typeof data === "string") {
      this.#routeEnvelope(data);
      return;
    }
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
    if (!bytes || !this.#secure) return;
    const frame = decodeFrame(bytes);
    if (!frame.ok) return;
    if (frame.value.kind === FrameKind.SecureHeader) {
      this.#secure.acceptHeader(frame.value.payload);
      this.#peerHeaderAccepted = true;
      this.#maybeReady();
      return;
    }
    if (frame.value.kind === FrameKind.Encrypted) {
      try {
        this.#routeEnvelope(dec.decode(this.#secure.decrypt(frame.value.payload)));
      } catch (cause) {
        this.events.emit("error", cause instanceof Error ? cause : new Error(String(cause)));
        this.#ws?.close(1008, "decrypt failed");
      }
    }
  }

  #routeEnvelope(json: string): void {
    const parsed = parseInbound(json);
    if (!parsed.ok) return;
    const msg = parsed.value;
    if (msg.type === "hello_ack") {
      if (this.#secure && this.#ws) {
        this.#ws.send(
          encodeFrame({
            kind: FrameKind.SecureHeader,
            streamId: 0,
            seq: 0,
            payload: this.#secure.createHeader(),
          }),
        );
        this.#ownHeaderSent = true;
        this.#maybeReady();
      } else {
        this.#becomeReady();
      }
      return;
    }
    if (msg.type === "hello_reject") {
      this.events.emit("error", new Error(`hello rejected: ${msg.payload.error.message}`));
      return;
    }
    if ("command_id" in msg && msg.type.endsWith(".result")) {
      const pending = this.#pending.get(msg.command_id);
      if (!pending) return;
      this.#pending.delete(msg.command_id);
      clearTimeout(pending.timer);
      const payload = msg.payload as
        | { status: "ok"; result: unknown }
        | { status: "error"; error: { message: string; code: string } };
      if (payload.status === "ok") pending.resolve(payload.result);
      else pending.reject(new Error(`${payload.error.code}: ${payload.error.message}`));
      return;
    }
    if ("stream" in msg && "seq" in msg) {
      this.#deliver(msg.stream, msg.seq, msg);
    }
  }

  #deliver(stream: string, seq: number, msg: KnownMessage): void {
    const buffer = this.#subs.get(stream);
    if (!buffer) {
      this.events.emit("event", msg);
      return;
    }
    for (const item of buffer.push(seq, msg)) this.events.emit("event", item);
  }

  #maybeReady(): void {
    if (this.#secure && this.#ownHeaderSent && this.#peerHeaderAccepted) this.#becomeReady();
  }

  #becomeReady(): void {
    this.#prevDelay = 0;
    this.#setState("ready");
    for (const [, pending] of this.#pending) this.#sendEnvelope(pending.json);
    for (const stream of this.#subs.keys()) void this.#establishSubscription(stream);
    this.#startHeartbeat();
  }

  async #establishSubscription(stream: string): Promise<void> {
    try {
      await this.command(SyncSubscribe, { streams: [stream] });
      const buffer = this.#subs.get(stream);
      if (!buffer) return;
      const replay = await this.command(SyncReplay, { stream, since: buffer.cursor, limit: 500 });
      for (const record of replay.events) {
        const envelope = eventEnvelopeFromRecord(record);
        if (envelope.ok) this.#deliver(stream, record.seq, envelope.value);
      }
    } catch (cause) {
      this.events.emit("error", cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  #sendEnvelope(json: string): void {
    if (!this.#ws) return;
    if (this.isSecure && this.#secure) {
      this.#ws.send(
        encodeFrame({
          kind: FrameKind.Encrypted,
          streamId: 0,
          seq: 0,
          payload: this.#secure.encrypt(enc.encode(json)),
        }),
      );
    } else {
      this.#ws.send(json);
    }
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    const timer = setInterval(() => {
      this.command(SysPing, {}, { timeoutMs: 5_000 }).catch(() =>
        this.#ws?.close(4001, "heartbeat failed"),
      );
    }, this.#opts.heartbeatMs);
    this.#heartbeatTimer = timer;
    (timer as { unref?: () => void }).unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }
}

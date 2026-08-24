import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

/**
 * Zero-knowledge relay: laptops dial OUT (one ws per machine), phones connect
 * from anywhere; the relay pairs them into channels and forwards opaque frames.
 * All command/event payloads are E2EE between phone and laptop — the relay
 * never sees plaintext and never logs payloads. Envelope (controller leg only;
 * the phone leg speaks the exact same protocol as a direct connection):
 *   {t:"open", ch, token}   relay → laptop   phone connected, presented device token
 *   {t:"msg",  ch, bin?, data}               both directions, data b64 when bin
 *   {t:"close", ch}                          either side hung up
 */

interface WsLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  ping?(): void;
  on(event: "message", cb: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "pong", cb: () => void): void;
  readyState?: number;
}

interface MachineEntry {
  controller: WsLike;
  phones: Map<string, WsLike>;
  alive: boolean;
}

export interface RelayOptions {
  token: string;
  maxFrameBytes?: number;
  maxChannelsPerMachine?: number;
  /** test hook: observe forwarded frames (sizes/content) without logging them */
  onForward?: (direction: "to_laptop" | "to_phone", data: Buffer | string) => void;
}

const HEARTBEAT_MS = 30_000;

function tokenOk(expected: string, presented: unknown): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

export async function buildRelay(options: RelayOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket, {
    options: { maxPayload: options.maxFrameBytes ?? 8 * 1024 * 1024 },
  });
  const maxChannels = options.maxChannelsPerMachine ?? 16;
  const machines = new Map<string, MachineEntry>();

  app.get("/healthz", async () => ({
    ok: true,
    machines: machines.size,
    channels: [...machines.values()].reduce((n, m) => n + m.phones.size, 0),
  }));

  app.get("/tunnel", { websocket: true }, (socket: WsLike, req: FastifyRequest) => {
    const q = req.query as Record<string, unknown>;
    const machineId = typeof q.machine === "string" ? q.machine : "";
    if (!tokenOk(options.token, q.rt) || machineId.length === 0) {
      socket.close(4401, "unauthorized");
      return;
    }

    if (q.role === "controller") {
      const previous = machines.get(machineId);
      previous?.controller.close(4000, "replaced by new controller connection");
      const entry: MachineEntry = { controller: socket, phones: new Map(), alive: true };
      machines.set(machineId, entry);

      socket.on("pong", () => {
        entry.alive = true;
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) return; // controller leg is JSON envelopes only
        let msg: { t?: string; ch?: string; bin?: boolean; data?: string };
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (typeof msg.ch !== "string") return;
        const phone = entry.phones.get(msg.ch);
        if (!phone) return;
        if (msg.t === "msg" && typeof msg.data === "string") {
          const out = msg.bin ? Buffer.from(msg.data, "base64") : msg.data;
          options.onForward?.("to_phone", out);
          phone.send(out);
        } else if (msg.t === "close") {
          entry.phones.delete(msg.ch);
          phone.close(1000, "closed by machine");
        }
      });
      socket.on("close", () => {
        if (machines.get(machineId) !== entry) return; // already replaced
        machines.delete(machineId);
        for (const [, phone] of entry.phones) phone.close(4410, "machine disconnected");
      });
      return;
    }

    // phone leg — raw protocol passthrough, wrapped into envelopes for the laptop
    const entry = machines.get(machineId);
    if (!entry) {
      socket.close(4404, "machine offline");
      return;
    }
    if (entry.phones.size >= maxChannels) {
      socket.close(4429, "too many connections");
      return;
    }
    const ch = randomUUID();
    entry.phones.set(ch, socket);
    entry.controller.send(
      JSON.stringify({ t: "open", ch, token: typeof q.token === "string" ? q.token : "" }),
    );
    socket.on("message", (data, isBinary) => {
      options.onForward?.("to_laptop", data);
      entry.controller.send(
        JSON.stringify(
          isBinary
            ? { t: "msg", ch, bin: true, data: data.toString("base64") }
            : { t: "msg", ch, data: data.toString() },
        ),
      );
    });
    socket.on("close", () => {
      if (entry.phones.delete(ch)) entry.controller.send(JSON.stringify({ t: "close", ch }));
    });
  });

  // dead-controller reaping keeps machine slots from wedging behind NAT timeouts
  const heartbeat = setInterval(() => {
    for (const [machineId, entry] of machines) {
      if (!entry.alive) {
        machines.delete(machineId);
        entry.controller.terminate?.();
        for (const [, phone] of entry.phones) phone.close(4410, "machine disconnected");
        continue;
      }
      entry.alive = false;
      entry.controller.ping?.();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  app.addHook("onClose", async () => clearInterval(heartbeat));

  return app;
}

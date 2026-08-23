import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import websocket from "@fastify/websocket";
import type { EventStore } from "@rdc/event-store";
import type { FilesystemService, FsIndex } from "@rdc/filesystem";
import type { GitService } from "@rdc/git";
import {
  AgentStatusChanged,
  decodeFrame,
  EditorStateChanged,
  encodeFrame,
  eventEnvelopeFromRecord,
  FrameKind,
  GitStatusChanged,
  gitStream,
  MachineHealthEvent,
  TerminalChanged,
  TerminalClosed,
} from "@rdc/protocol";
import { fromB64, hashToken, type KxKeypair, SecureChannel } from "@rdc/security";
import type { TerminalManager } from "@rdc/terminal";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import QRCode from "qrcode";
import type { AgentManager } from "./agent-manager.ts";
import type { DeviceRecord, DeviceStore } from "./device-store.ts";
import { type ClientContext, ControllerDispatcher, newClientContext } from "./dispatcher.ts";
import type { EditorRegistry } from "./editors.ts";
import type { KeepAwake } from "./keep-awake.ts";
import type { HealthMonitor } from "./machine-health.ts";
import type { PairingCoordinator } from "./pairing-coordinator.ts";

export interface ServerDeps {
  machineId: string;
  machineName: string;
  localToken: string;
  keys: KxKeypair;
  devices: DeviceStore;
  pairing: PairingCoordinator;
  fsService: FilesystemService;
  fsIndex: FsIndex;
  eventStore: EventStore;
  health: HealthMonitor;
  keepAwake: KeepAwake;
  git: GitService;
  editors: EditorRegistry;
  agents: AgentManager;
  terminals: TerminalManager;
}

/** localhost names + this machine's own interface IPs (LAN clients send Host: <lan-ip>:port). */
function collectAllowedHostnames(): Set<string> {
  const allowed = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4") allowed.add(info.address);
    }
  }
  return allowed;
}

function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

function extractToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof q === "string" && q.length > 0) return q;
  const cookie = req.headers.cookie;
  if (cookie) {
    const match = /(?:^|;\s*)rdc_token=([^;]+)/.exec(cookie);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

function hostAllowed(hostHeader: string | undefined, allowed: Set<string>): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : (hostHeader.split(":")[0] ?? "");
  return allowed.has(hostname);
}

function originAllowed(origin: string | undefined, allowed: Set<string>): boolean {
  if (origin === undefined) return true; // non-browser clients send no Origin
  try {
    return allowed.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

let dashHtmlCache: string | null = null;
function dashHtml(): string {
  dashHtmlCache ??= readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "dash.html"),
    "utf8",
  );
  return dashHtmlCache;
}

/** Structural socket type — avoids a hard dependency on ws's type package. */
interface WsLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "close", cb: () => void): void;
}

interface ConnectedClient {
  ctx: ClientContext;
  sendJson: (json: string) => void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Local HTTP/WS server, hardened per PLAN §19/§38: Host + Origin validation
 * (DNS-rebinding defense — LAN IPs of this machine are allowed for phone
 * clients), token auth on everything except /healthz and /pair, and a
 * mandatory E2EE secretstream channel for paired devices.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const dispatcher = new ControllerDispatcher(deps);
  const clients = new Map<WsLike, ConnectedClient>();
  const allowedHosts = collectAllowedHostnames();
  const requestDevices = new WeakMap<FastifyRequest, DeviceRecord>();

  app.addHook("onRequest", async (req, reply) => {
    if (
      !hostAllowed(req.headers.host, allowedHosts) ||
      !originAllowed(req.headers.origin, allowedHosts)
    ) {
      return reply.code(403).send({ error: "forbidden host/origin" });
    }
    const routePath = req.url.split("?")[0];
    if (routePath === "/healthz" || routePath === "/pair") return;
    const presented = extractToken(req);
    if (tokenMatches(deps.localToken, presented)) return; // local caller (dashboard/extension)
    if (presented) {
      const device = deps.devices.findByTokenHash(hashToken(presented));
      if (device) {
        requestDevices.set(req, device);
        return;
      }
    }
    return reply.code(401).send({ error: "missing or invalid token" });
  });

  app.get("/healthz", async () => ({ ok: true, machine_id: deps.machineId }));

  app.get("/dash", async (req, reply) => {
    const q = (req.query as Record<string, unknown> | undefined)?.token;
    if (typeof q === "string") {
      // Move the token out of the URL into an HttpOnly cookie, then clean the address bar.
      reply.header(
        "set-cookie",
        `rdc_token=${encodeURIComponent(q)}; HttpOnly; SameSite=Strict; Path=/`,
      );
      return reply.redirect("/dash");
    }
    return reply.type("text/html").send(dashHtml());
  });

  // ── Pairing (dashboard-driven, PLAN §20) ────────────────────────────────
  app.post("/api/pairing/start", async () => {
    const started = deps.pairing.start();
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    // Only LAN-reachable addresses belong in the QR — loopback is the phone's own.
    const lanHosts = [...allowedHosts].filter(
      (h) => h !== "::1" && h !== "[::1]" && h !== "localhost" && h !== "127.0.0.1",
    );
    const addrs = (lanHosts.length > 0 ? lanHosts : ["127.0.0.1"]).map((h) => `ws://${h}:${port}`);
    const payload = deps.pairing.qrPayload(addrs);
    const qrDataUrl = await QRCode.toDataURL(JSON.stringify(payload), { margin: 1, width: 260 });
    return {
      code: started.code,
      expires_at: started.expiresAt,
      qr_payload: payload,
      qr_data_url: qrDataUrl,
    };
  });

  app.get("/api/pairing/status", async () => deps.pairing.status());

  app.post("/api/pairing/confirm", async (_req, reply) => {
    const granted = deps.pairing.confirm();
    if (!granted) return reply.code(409).send({ error: "nothing pending confirmation" });
    return { ok: true, ...granted };
  });

  app.post("/api/pairing/cancel", async () => {
    deps.pairing.cancel();
    return { ok: true };
  });

  app.get("/api/devices", async () => ({ devices: deps.devices.list() }));

  /** Unauthenticated by design — gated by the one-time code + lockout inside the coordinator. */
  app.get("/pair", { websocket: true }, (socket: WsLike) => {
    const adapter = {
      send: (json: string) => socket.send(json),
      close: (code?: number, reason?: string) => socket.close(code, reason),
    };
    deps.pairing.attachSocket(adapter);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1008, "binary not allowed on /pair");
        return;
      }
      deps.pairing.handlePairMessage(data.toString());
    });
    socket.on("close", () => deps.pairing.detachSocket(adapter));
  });

  // ── Protocol endpoint (E2EE mandatory for paired devices) ──────────────────
  app.get("/ws", { websocket: true }, (socket: WsLike, req: FastifyRequest) => {
    const device = requestDevices.get(req);
    const ctx = newClientContext();
    const secure = device ? new SecureChannel("server", deps.keys, fromB64(device.kx_pub)) : null;
    let ownHeaderSent = false;
    let peerHeaderAccepted = false;
    const encReady = () => secure !== null && ownHeaderSent && peerHeaderAccepted;

    const sendJson = (json: string) => {
      if (secure && encReady()) {
        socket.send(
          encodeFrame({
            kind: FrameKind.Encrypted,
            streamId: 0,
            seq: 0,
            payload: secure.encrypt(enc.encode(json)),
          }),
        );
      } else {
        socket.send(json);
      }
    };
    clients.set(socket, { ctx, sendJson });
    deps.editors.attach(ctx, sendJson);

    const afterDispatch = () => {
      // server's secretstream header goes out right after the hello exchange
      if (secure && ctx.helloDone && !ownHeaderSent) {
        socket.send(
          encodeFrame({
            kind: FrameKind.SecureHeader,
            streamId: 0,
            seq: 0,
            payload: secure.createHeader(),
          }),
        );
        ownHeaderSent = true;
      }
    };

    // per-connection serialization: async handlers must not interleave
    let inbound: Promise<void> = Promise.resolve();
    const handleJson = (raw: string) => {
      inbound = inbound
        .then(async () => {
          for (const response of await dispatcher.handle(raw, ctx)) sendJson(response);
          afterDispatch();
        })
        .catch(() => {
          socket.close(1011, "internal error");
        });
    };

    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        if (secure && encReady()) {
          socket.close(1008, "plaintext after secure handshake");
          return;
        }
        handleJson(data.toString());
        return;
      }
      if (!secure) {
        socket.close(1008, "unexpected binary frame");
        return;
      }
      const frame = decodeFrame(new Uint8Array(data));
      if (!frame.ok) {
        socket.close(1008, "malformed frame");
        return;
      }
      if (frame.value.kind === FrameKind.SecureHeader) {
        secure.acceptHeader(frame.value.payload);
        peerHeaderAccepted = true;
        afterDispatch();
        return;
      }
      if (frame.value.kind === FrameKind.Encrypted) {
        if (!encReady()) {
          socket.close(1008, "encrypted frame before handshake");
          return;
        }
        try {
          handleJson(dec.decode(secure.decrypt(frame.value.payload)));
        } catch {
          socket.close(1008, "decrypt failed");
        }
        return;
      }
      socket.close(1008, "unsupported frame kind");
    });
    socket.on("close", () => {
      clients.delete(socket);
      deps.editors.detach(ctx);
    });
  });

  // Live push: journaled events → sockets subscribed to that stream (encrypted per client).
  deps.fsService.emitter.on("events", (stored) => {
    for (const record of stored) {
      const envelope = eventEnvelopeFromRecord(record);
      if (!envelope.ok) continue;
      const json = JSON.stringify(envelope.value);
      for (const [, client] of clients) {
        if (client.ctx.helloDone && client.ctx.subscriptions.has(record.stream))
          client.sendJson(json);
      }
    }
  });

  // Live push: health telemetry every 5s to every connected client (ephemeral, not journaled).
  let healthSeq = 0;
  const healthTimer = setInterval(() => {
    if (clients.size === 0) return;
    healthSeq += 1;
    const json = JSON.stringify(
      MachineHealthEvent.create("machine", healthSeq, {
        ...deps.health.quickSnapshot(),
        keep_awake: deps.keepAwake.state(),
      }),
    );
    for (const [, client] of clients) {
      if (client.ctx.helloDone) client.sendJson(json);
    }
  }, 5_000);
  (healthTimer as { unref?: () => void }).unref?.();
  app.addHook("onClose", async () => clearInterval(healthTimer));

  // Live push: git status changes (branch switch, stage, commit…) — ephemeral, not journaled.
  let gitSeq = 0;
  deps.git.emitter.on("status", (state) => {
    gitSeq += 1;
    const json = JSON.stringify(
      GitStatusChanged.create(gitStream(state.project_id), gitSeq, state),
    );
    for (const [, client] of clients) {
      if (client.ctx.helloDone) client.sendJson(json);
    }
  });

  // Live push: editors snapshot on any window state change (ephemeral, not journaled).
  let editorSeq = 0;
  deps.editors.emitter.on("changed", (editors) => {
    editorSeq += 1;
    const json = JSON.stringify(EditorStateChanged.create("editor", editorSeq, { editors }));
    for (const [, client] of clients) {
      if (client.ctx.helloDone) client.sendJson(json);
    }
  });

  // Live push: journaled agent events → subscribers of that agent stream;
  // status changes additionally broadcast to everyone (session list liveness).
  deps.agents.emitter.on("journaled", (stored) => {
    for (const record of stored) {
      const envelope = eventEnvelopeFromRecord(record);
      if (!envelope.ok) continue;
      const json = JSON.stringify(envelope.value);
      for (const [, client] of clients) {
        if (client.ctx.helloDone && client.ctx.subscriptions.has(record.stream))
          client.sendJson(json);
      }
    }
  });
  let agentSeq = 0;
  deps.agents.emitter.on("status", (session) => {
    agentSeq += 1;
    const json = JSON.stringify(AgentStatusChanged.create("agent", agentSeq, { session }));
    for (const [, client] of clients) {
      if (client.ctx.helloDone) client.sendJson(json);
    }
  });

  // Live push: terminal output pings + close events (ephemeral).
  let terminalSeq = 0;
  deps.terminals.emitter.on("changed", (event) => {
    terminalSeq += 1;
    const json = JSON.stringify(TerminalChanged.create("terminal", terminalSeq, event));
    for (const [, client] of clients) {
      if (client.ctx.helloDone) client.sendJson(json);
    }
  });
  deps.terminals.emitter.on("closed", (event) => {
    terminalSeq += 1;
    const json = JSON.stringify(TerminalClosed.create("terminal", terminalSeq, event));
    for (const [, client] of clients) {
      if (client.ctx.helloDone) client.sendJson(json);
    }
  });

  // Worktree edits invalidate git status too (index/HEAD changes come from the .git watcher).
  deps.fsService.emitter.on("events", (stored) => {
    const touched = new Set<string>();
    for (const record of stored) {
      if (record.stream.startsWith("fs:")) touched.add(record.stream.slice(3));
    }
    for (const projectId of touched) deps.git.scheduleRefresh(projectId);
  });

  return app;
}

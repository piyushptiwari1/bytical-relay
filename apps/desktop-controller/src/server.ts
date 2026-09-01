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
  type ApprovalRequest,
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
import type { AuditLog } from "./audit-log.ts";
import { DataConsole } from "./data-console.ts";
import type { DeviceRecord, DeviceStore } from "./device-store.ts";
import {
  type ClientContext,
  ControllerDispatcher,
  canAccessStream,
  hasClientScope,
  newClientContext,
} from "./dispatcher.ts";
import type { EditorRegistry } from "./editors.ts";
import type { KeepAwake } from "./keep-awake.ts";
import type { HealthMonitor } from "./machine-health.ts";
import type { PairingCoordinator } from "./pairing-coordinator.ts";
import { type PushMessage, sendExpoPush } from "./push.ts";

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
  audit?: AuditLog;
  relay?: { url: string; token: string };
  /** fired with the number of authenticated phone sockets whenever it changes */
  onDeviceConnections?: (count: number) => void;
  /** owner analytics console (/data) — password + data dir; absent = disabled */
  dataConsole?: { password: string; dataDir: string; analytics?: { url: string; token: string } };
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

let dataHtmlCache: string | null = null;
function dataHtml(): string {
  dataHtmlCache ??= readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "data.html"),
    "utf8",
  );
  return dataHtmlCache;
}

function dataLoginHtml(error = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Relay — data console</title><style>
body{background:#0d1414;color:#e8f1ef;font:14px ui-sans-serif,system-ui;display:grid;place-items:center;height:100vh;margin:0}
form{background:#121c1c;border:1px solid #1e2b2b;border-radius:14px;padding:34px;width:300px}
h1{font-size:16px;margin:0 0 4px}h1 b{color:#4fd1b0}p{color:#7d938f;font-size:12px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;background:#0d1414;border:1px solid #1e2b2b;border-radius:8px;color:#e8f1ef;padding:10px;font-size:14px}
button{width:100%;margin-top:12px;background:#4fd1b0;border:0;border-radius:8px;padding:10px;font-weight:600;cursor:pointer}
.err{color:#e07a6a;font-size:12px;margin-top:10px}</style></head><body>
<form method="post" action="/data/login"><h1><b>Relay</b> data console</h1><p>Owner access only.</p>
<input type="password" name="password" placeholder="Password" autofocus>
<button>Open console</button>${error ? `<div class="err">${error}</div>` : ""}</form></body></html>`;
}

/** Structural socket type — avoids a hard dependency on ws's type package. */
export interface WsLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "close", cb: () => void): void;
}

interface ConnectedClient {
  ctx: ClientContext;
  sendJson: (json: string) => void;
}

function publicDevice(device: DeviceRecord, connected: boolean) {
  return {
    device_id: device.device_id,
    name: device.name,
    scopes: device.scopes,
    expires_at: new Date(device.expires_at).toISOString(),
    created_at: device.created_at,
    revoked: device.revoked,
    connected,
    last_seen_at: device.last_seen_at,
    last_transport: device.last_transport,
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Local HTTP/WS server, hardened per PLAN §19/§38: Host + Origin validation
 * (DNS-rebinding defense — LAN IPs of this machine are allowed for phone
 * clients), token auth on everything except /healthz and /pair, and a
 * mandatory E2EE secretstream channel for paired devices.
 */
export async function buildServer(deps: ServerDeps): Promise<{
  app: FastifyInstance;
  /** feed a protocol connection from any transport (direct ws or relay tunnel) */
  attachProtocolSocket: (
    socket: WsLike,
    device: DeviceRecord | undefined,
    transport?: "direct" | "relay",
  ) => void;
}> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  // login form posts urlencoded; fastify only parses JSON by default
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );
  const dispatcher = new ControllerDispatcher(deps);
  const clients = new Map<WsLike, ConnectedClient>();
  const notifyDeviceConnections = () => {
    let phones = 0;
    for (const client of clients.values()) if (client.ctx.authenticatedDeviceId) phones++;
    deps.onDeviceConnections?.(phones);
  };
  const sendAgentPush = (message: PushMessage) => {
    const tokens = deps.devices.allPushTokens("agents.control");
    if (tokens.length === 0) return;
    void sendExpoPush(tokens, message)
      .then((tickets) => {
        // Tickets align with recipient tokens; remove registrations Expo says are no longer valid.
        tickets.forEach((ticket, index) => {
          const token = tokens[index];
          if (token && ticket.details?.error === "DeviceNotRegistered") {
            deps.devices.removePushToken(token);
          }
        });
      })
      .catch(() => {
        // Push is best effort; a connected client still receives the live event stream.
      });
  };
  // Wi-Fi roaming/DHCP changes IPs while running — recompute, cached briefly.
  let allowedHosts = collectAllowedHostnames();
  let allowedHostsAt = Date.now();
  const freshAllowedHosts = (): Set<string> => {
    if (Date.now() - allowedHostsAt > 5_000) {
      allowedHosts = collectAllowedHostnames();
      allowedHostsAt = Date.now();
    }
    return allowedHosts;
  };
  const requestDevices = new WeakMap<FastifyRequest, DeviceRecord>();
  const localRequests = new WeakSet<FastifyRequest>();

  app.addHook("onRequest", async (req, reply) => {
    const hosts = freshAllowedHosts();
    if (!hostAllowed(req.headers.host, hosts) || !originAllowed(req.headers.origin, hosts)) {
      return reply.code(403).send({ error: "forbidden host/origin" });
    }
    const routePath = req.url.split("?")[0];
    if (routePath === "/healthz" || routePath === "/pair") return;
    // /data has its own password gate (owner console); disabled unless configured
    if (routePath === "/data" || routePath === "/data/login" || routePath === "/api/data/stats") {
      return;
    }
    const presented = extractToken(req);
    if (tokenMatches(deps.localToken, presented)) {
      localRequests.add(req);
      return; // local caller (dashboard/extension)
    }
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

  // ── Owner analytics console (/data) — password-gated, local data only ──────
  const dataConsole = deps.dataConsole
    ? new DataConsole(
        deps.dataConsole.password,
        deps.dataConsole.dataDir,
        deps.dataConsole.analytics,
      )
    : null;

  app.get("/data", async (req, reply) => {
    if (!dataConsole) return reply.code(404).send({ error: "not found" });
    if (!dataConsole.validSession(req.headers.cookie)) {
      return reply.type("text/html").send(dataLoginHtml());
    }
    return reply.type("text/html").send(dataHtml());
  });

  app.post("/data/login", async (req, reply) => {
    if (!dataConsole) return reply.code(404).send({ error: "not found" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const presented = typeof body.password === "string" ? body.password : "";
    if (!dataConsole.checkPassword(presented)) {
      deps.audit?.append({
        ts: new Date().toISOString(),
        actor: "local",
        action: "data_console.login_failed",
      });
      return reply.code(401).type("text/html").send(dataLoginHtml("Wrong password."));
    }
    deps.audit?.append({
      ts: new Date().toISOString(),
      actor: "local",
      action: "data_console.login",
    });
    reply.header(
      "set-cookie",
      `rdc_data=${encodeURIComponent(dataConsole.issueSession())}; HttpOnly; SameSite=Strict; Path=/`,
    );
    return reply.redirect("/data");
  });

  app.get("/api/data/stats", async (req, reply) => {
    if (!dataConsole) return reply.code(404).send({ error: "not found" });
    if (!dataConsole.validSession(req.headers.cookie)) {
      return reply.code(401).send({ error: "login required" });
    }
    return dataConsole.stats();
  });

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
    const lanHosts = [...freshAllowedHosts()].filter(
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
    deps.audit?.append({
      ts: new Date().toISOString(),
      actor: "local_owner",
      action: granted.repaired ? "device.repaired" : "device.paired",
      details: { device_id: granted.device_id, device_name: granted.device_name },
    });
    return { ok: true, ...granted };
  });

  app.post("/api/pairing/cancel", async () => {
    deps.pairing.cancel();
    return { ok: true };
  });

  const closePairedDeviceSockets = (deviceId?: string) => {
    for (const [socket, client] of clients) {
      if (
        client.ctx.authenticatedDeviceId !== null &&
        (deviceId === undefined || client.ctx.authenticatedDeviceId === deviceId)
      ) {
        socket.close(1008, "paired device access revoked");
      }
    }
  };

  app.get("/api/devices", async (req, reply) => {
    if (!localRequests.has(req))
      return reply.code(403).send({ error: "local owner token required" });
    const connectedDeviceIds = new Set(
      [...clients.values()]
        .map((client) => client.ctx.authenticatedDeviceId)
        .filter((deviceId): deviceId is string => deviceId !== null),
    );
    return {
      devices: deps.devices
        .list()
        .map((device) => publicDevice(device, connectedDeviceIds.has(device.device_id))),
    };
  });

  app.post("/api/devices/:deviceId/revoke", async (req, reply) => {
    if (!localRequests.has(req))
      return reply.code(403).send({ error: "local owner token required" });
    const deviceId = (req.params as { deviceId?: string }).deviceId;
    if (!deviceId || !deps.devices.revoke(deviceId))
      return reply.code(404).send({ error: "paired device not found" });
    closePairedDeviceSockets(deviceId);
    deps.audit?.append({
      ts: new Date().toISOString(),
      actor: "local_owner",
      action: "device.revoke",
      details: { device_id: deviceId },
    });
    return { revoked: true };
  });

  app.post("/api/devices/revoke-all", async (req, reply) => {
    if (!localRequests.has(req))
      return reply.code(403).send({ error: "local owner token required" });
    const revoked = deps.devices.revokeAll();
    closePairedDeviceSockets();
    deps.audit?.append({
      ts: new Date().toISOString(),
      actor: "local_owner",
      action: "device.revoke_all",
      details: { count: String(revoked) },
    });
    return { revoked };
  });

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
  const attachProtocolSocket = (
    socket: WsLike,
    device: DeviceRecord | undefined,
    transport: "direct" | "relay" = "direct",
  ): void => {
    const ctx = newClientContext(
      device?.device_id ?? null,
      device?.scopes ?? null,
      device ? transport : null,
    );
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
    notifyDeviceConnections();

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
      notifyDeviceConnections();
    });
  };

  app.get("/ws", { websocket: true }, (socket: WsLike, req: FastifyRequest) => {
    attachProtocolSocket(socket, requestDevices.get(req));
  });

  // Live push: journaled events → sockets subscribed to that stream (encrypted per client).
  deps.fsService.emitter.on("events", (stored) => {
    for (const record of stored) {
      const envelope = eventEnvelopeFromRecord(record);
      if (!envelope.ok) continue;
      const json = JSON.stringify(envelope.value);
      for (const [, client] of clients) {
        if (
          client.ctx.helloDone &&
          client.ctx.subscriptions.has(record.stream) &&
          canAccessStream(client.ctx, record.stream)
        )
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
      if (client.ctx.helloDone && hasClientScope(client.ctx, "machine.read")) client.sendJson(json);
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
      if (client.ctx.helloDone && hasClientScope(client.ctx, "git.read")) client.sendJson(json);
    }
  });

  // Live push: editors snapshot on any window state change (ephemeral, not journaled).
  let editorSeq = 0;
  deps.editors.emitter.on("changed", (editors) => {
    editorSeq += 1;
    const json = JSON.stringify(EditorStateChanged.create("editor", editorSeq, { editors }));
    for (const [, client] of clients) {
      if (client.ctx.helloDone && hasClientScope(client.ctx, "editor.read")) client.sendJson(json);
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
        if (
          client.ctx.helloDone &&
          client.ctx.subscriptions.has(record.stream) &&
          canAccessStream(client.ctx, record.stream)
        )
          client.sendJson(json);
      }
      if (record.type !== "approval.requested") continue;
      const approval = record.payload as Partial<ApprovalRequest>;
      if (
        typeof approval.session_id !== "string" ||
        typeof approval.approval_id !== "string" ||
        !Array.isArray(approval.options)
      ) {
        continue;
      }
      const skipOption = approval.options.find(
        (option) => option.option_kind === "reject_once",
      )?.option_id;
      sendAgentPush({
        title: "Approval needed",
        body: "A Relay agent needs a decision.",
        categoryId: "relay_approval",
        data: {
          machine: deps.machineId,
          session: approval.session_id,
          approval_id: approval.approval_id,
          ...(skipOption ? { skip_option_id: skipOption } : {}),
        },
      });
    }
  });
  let agentSeq = 0;
  const pushStatus = new Map<string, string>();
  deps.agents.emitter.on("status", (session) => {
    agentSeq += 1;
    const json = JSON.stringify(AgentStatusChanged.create("agent", agentSeq, { session }));
    for (const [, client] of clients) {
      if (client.ctx.helloDone && hasClientScope(client.ctx, "agents.read")) client.sendJson(json);
    }
    // S7b: remote push for killed-app delivery (no-op until tokens registered)
    const previous = pushStatus.get(session.session_id);
    pushStatus.set(session.session_id, session.status);
    if (previous === session.status) return;
    const title =
      session.status === "failed"
        ? "Agent needs review"
        : session.status === "idle" && previous === "running"
          ? "Agent finished"
          : null;
    if (!title) return;
    sendAgentPush({
      title,
      body: "Open Relay to review the result.",
      data: { machine: deps.machineId, session: session.session_id },
    });
  });

  // Live push: terminal output pings + close events (ephemeral).
  let terminalSeq = 0;
  deps.terminals.emitter.on("changed", (event) => {
    terminalSeq += 1;
    const json = JSON.stringify(TerminalChanged.create("terminal", terminalSeq, event));
    for (const [, client] of clients) {
      if (client.ctx.helloDone && hasClientScope(client.ctx, "terminals.read"))
        client.sendJson(json);
    }
  });
  deps.terminals.emitter.on("closed", (event) => {
    terminalSeq += 1;
    const json = JSON.stringify(TerminalClosed.create("terminal", terminalSeq, event));
    for (const [, client] of clients) {
      if (client.ctx.helloDone && hasClientScope(client.ctx, "terminals.read"))
        client.sendJson(json);
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

  return { app, attachProtocolSocket };
}

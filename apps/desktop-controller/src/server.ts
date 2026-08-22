import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import websocket from "@fastify/websocket";
import type { EventStore } from "@rdc/event-store";
import type { FilesystemService, FsIndex } from "@rdc/filesystem";
import { eventEnvelopeFromRecord } from "@rdc/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { type ClientContext, ControllerDispatcher, newClientContext } from "./dispatcher.ts";

export interface ServerDeps {
  machineId: string;
  localToken: string;
  fsService: FilesystemService;
  fsIndex: FsIndex;
  eventStore: EventStore;
}

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

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

function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : (hostHeader.split(":")[0] ?? "");
  return LOCAL_HOSTNAMES.has(hostname);
}

function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true; // non-browser clients send no Origin
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
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
  send(data: string): void;
  on(event: "message", cb: (data: Buffer) => void): void;
  on(event: "close", cb: () => void): void;
}

/**
 * Local HTTP/WS server, hardened per PLAN §19/§38: binds 127.0.0.1 only (caller),
 * validates Host + Origin (DNS-rebinding defense), and requires the local token
 * on every request except /healthz — even from localhost.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const dispatcher = new ControllerDispatcher(deps);
  const clients = new Map<WsLike, ClientContext>();

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz") return;
    if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
      return reply.code(403).send({ error: "forbidden host/origin" });
    }
    if (!tokenMatches(deps.localToken, extractToken(req))) {
      return reply.code(401).send({ error: "missing or invalid token" });
    }
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

  app.get("/ws", { websocket: true }, (socket) => {
    const ctx = newClientContext();
    clients.set(socket, ctx);
    socket.on("message", (data: Buffer) => {
      for (const response of dispatcher.handle(data.toString(), ctx)) {
        socket.send(response);
      }
    });
    socket.on("close", () => clients.delete(socket));
  });

  // Live push: journaled events → sockets subscribed to that stream.
  deps.fsService.emitter.on("events", (stored) => {
    for (const record of stored) {
      const envelope = eventEnvelopeFromRecord(record);
      if (!envelope.ok) continue;
      const json = JSON.stringify(envelope.value);
      for (const [socket, ctx] of clients) {
        if (ctx.helloDone && ctx.subscriptions.has(record.stream)) socket.send(json);
      }
    }
  });

  return app;
}

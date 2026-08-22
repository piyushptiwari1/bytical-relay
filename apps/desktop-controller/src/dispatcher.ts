import type { EventStore } from "@rdc/event-store";
import type { FilesystemService, FsIndex } from "@rdc/filesystem";
import {
  DebugEcho,
  FileList,
  HelloAck,
  HelloReject,
  type KnownMessage,
  negotiateVersion,
  ProjectList,
  parseInbound,
  protocolError,
  SUPPORTED_VERSIONS,
  SyncReplay,
  SyncSubscribe,
  SysPing,
} from "@rdc/protocol";
import { nowIso } from "@rdc/shared";

export interface ClientContext {
  helloDone: boolean;
  deviceId: string | null;
  subscriptions: Set<string>;
}

export const newClientContext = (): ClientContext => ({
  helloDone: false,
  deviceId: null,
  subscriptions: new Set(),
});

export interface DispatcherDeps {
  machineId: string;
  fsService: FilesystemService;
  fsIndex: FsIndex;
  eventStore: EventStore;
}

/**
 * Transport-agnostic protocol router: raw wire JSON in, wire JSON out.
 * Reused later by the relay transport in S7 — sockets stay dumb.
 */
export class ControllerDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  handle(raw: string, ctx: ClientContext): string[] {
    const parsed = parseInbound(raw);
    if (!parsed.ok) {
      return [
        JSON.stringify(HelloReject.create({ error: parsed.error, supported: SUPPORTED_VERSIONS })),
      ];
    }
    return this.#dispatch(parsed.value, ctx).map((m) => JSON.stringify(m));
  }

  #dispatch(msg: KnownMessage, ctx: ClientContext): unknown[] {
    if (msg.type === "hello") {
      const negotiated = negotiateVersion(SUPPORTED_VERSIONS, msg.payload.protocol);
      if (negotiated === null) {
        return [
          HelloReject.create({
            error: protocolError("UPGRADE_REQUIRED", "no common protocol version"),
            supported: SUPPORTED_VERSIONS,
          }),
        ];
      }
      ctx.helloDone = true;
      ctx.deviceId = msg.payload.device_id;
      return [
        HelloAck.create({
          negotiated_version: negotiated,
          machine_id: this.deps.machineId,
          server_ts: nowIso(),
        }),
      ];
    }
    if (!ctx.helloDone) {
      const commandId = "command_id" in msg ? msg.command_id : null;
      if (commandId && msg.type === "project.list") {
        return [ProjectList.createError(commandId, protocolError("FORBIDDEN", "hello required"))];
      }
      return commandId
        ? [DebugEcho.createError(commandId, protocolError("FORBIDDEN", "hello required"))]
        : [];
    }
    switch (msg.type) {
      case "project.list":
        return [
          ProjectList.createOk(msg.command_id, {
            projects: this.deps.fsService.projectsWithVersion(),
          }),
        ];
      case "file.list": {
        const { project_id, parent_id } = msg.payload;
        if (this.deps.fsIndex.getProjectRoot(project_id) === undefined) {
          return [
            FileList.createError(
              msg.command_id,
              protocolError("NOT_FOUND", `unknown project: ${project_id}`),
            ),
          ];
        }
        return [
          FileList.createOk(msg.command_id, {
            entries: this.deps.fsIndex.childrenOf(project_id, parent_id),
          }),
        ];
      }
      case "sync.subscribe": {
        for (const stream of msg.payload.streams) ctx.subscriptions.add(stream);
        return [SyncSubscribe.createOk(msg.command_id, { subscribed: [...ctx.subscriptions] })];
      }
      case "sync.replay": {
        const { stream, since, limit } = msg.payload;
        return [
          SyncReplay.createOk(msg.command_id, {
            events: this.deps.eventStore.read(stream, since, limit),
            head_seq: this.deps.eventStore.headSeq(stream),
          }),
        ];
      }
      case "sys.ping":
        return [SysPing.createOk(msg.command_id, { pong: nowIso() })];
      case "debug.echo": {
        const cached = this.deps.eventStore.getCommandResult(msg.command_id);
        if (cached !== undefined) {
          return [
            DebugEcho.createOk(msg.command_id, cached as { echoed: string }, { duplicate: true }),
          ];
        }
        const result = { echoed: msg.payload.text };
        this.deps.eventStore.putCommandResult(msg.command_id, result, 60_000);
        return [DebugEcho.createOk(msg.command_id, result)];
      }
      default:
        return []; // events/results from peers are not commands — nothing to answer
    }
  }
}

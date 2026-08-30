import { open } from "node:fs/promises";
import path from "node:path";
import type { EventStore } from "@rdc/event-store";
import type { FilesystemService, FsIndex } from "@rdc/filesystem";
import { isSensitivePath, resolveInsideProject } from "@rdc/filesystem";
import type { GitService } from "@rdc/git";
import {
  AgentArchive,
  AgentCancel,
  AgentList,
  AgentPrompt,
  AgentResume,
  AgentStart,
  ApprovalRespond,
  DebugEcho,
  DeviceRotateToken,
  EditorAskChat,
  EditorChatRequested,
  EditorList,
  EditorOpenFile,
  EditorOpenRequested,
  EditorPublishState,
  FileList,
  FileRead,
  GitCommit,
  GitDiffFile,
  GitStage,
  GitStatus,
  GitUnstage,
  HelloAck,
  HelloReject,
  type KnownMessage,
  MachineKeepAwake,
  MachineStatus,
  NotifyRegister,
  NotifyTest,
  negotiateVersion,
  ProjectList,
  parseInbound,
  protocolError,
  SUPPORTED_VERSIONS,
  SyncReplay,
  SyncSubscribe,
  SysPing,
  TerminalCreate,
  TerminalKill,
  TerminalList,
  TerminalResize,
  TerminalSnapshotCmd,
  TerminalWrite,
} from "@rdc/protocol";
import { issueRelayTicketBundle, issueToken } from "@rdc/security";
import { nowIso } from "@rdc/shared";
import type { TerminalManager } from "@rdc/terminal";
import type { AgentManager } from "./agent-manager.ts";
import type { AuditLog } from "./audit-log.ts";
import { DEVICE_TOKEN_TTL_MS, type DeviceStore } from "./device-store.ts";
import type { EditorRegistry } from "./editors.ts";
import type { KeepAwake } from "./keep-awake.ts";
import type { HealthMonitor } from "./machine-health.ts";
import { sendExpoPush } from "./push.ts";

export interface ClientContext {
  helloDone: boolean;
  deviceId: string | null;
  authenticatedDeviceId: string | null;
  /** null means a local-owner connection authenticated by the controller token. */
  authenticatedScopes: readonly string[] | null;
  authenticatedTransport: "direct" | "relay" | null;
  subscriptions: Set<string>;
}

export const newClientContext = (
  authenticatedDeviceId: string | null = null,
  authenticatedScopes: readonly string[] | null = authenticatedDeviceId === null ? null : [],
  authenticatedTransport: "direct" | "relay" | null = authenticatedDeviceId === null
    ? null
    : "direct",
): ClientContext => ({
  helloDone: false,
  deviceId: authenticatedDeviceId,
  authenticatedDeviceId,
  authenticatedScopes,
  authenticatedTransport,
  subscriptions: new Set(),
});

/** Local-owner connections bypass scopes; paired devices need an explicit matching capability. */
export function hasClientScope(ctx: ClientContext, scope: string): boolean {
  return (
    ctx.authenticatedScopes === null ||
    ctx.authenticatedScopes.includes("*") ||
    ctx.authenticatedScopes.includes(scope)
  );
}

/** Resolve the least privilege needed to observe a journal stream. Unknown streams stay local-only. */
export function canAccessStream(ctx: ClientContext, stream: string): boolean {
  if (ctx.authenticatedScopes === null) return true;
  if (stream === "machine") return hasClientScope(ctx, "machine.read");
  if (stream === "editor") return hasClientScope(ctx, "editor.read");
  if (stream.startsWith("fs:")) return hasClientScope(ctx, "files.read");
  if (stream.startsWith("git:")) return hasClientScope(ctx, "git.read");
  if (stream.startsWith("agent:")) return hasClientScope(ctx, "agents.read");
  if (stream.startsWith("terminal")) return hasClientScope(ctx, "terminals.read");
  return false;
}

type CommandErrorDefinition = {
  createError(commandId: string, error: ReturnType<typeof protocolError>): unknown;
};

const SCOPED_COMMANDS: Record<string, { scope: string; definition: CommandErrorDefinition }> = {
  "project.list": { scope: "projects.read", definition: ProjectList },
  "file.list": { scope: "files.read", definition: FileList },
  "file.read": { scope: "files.read", definition: FileRead },
  "git.status": { scope: "git.read", definition: GitStatus },
  "git.diff_file": { scope: "git.read", definition: GitDiffFile },
  "git.stage": { scope: "git.write", definition: GitStage },
  "git.unstage": { scope: "git.write", definition: GitUnstage },
  "git.commit": { scope: "git.write", definition: GitCommit },
  "editor.publish_state": { scope: "editor.publish", definition: EditorPublishState },
  "editor.list": { scope: "editor.read", definition: EditorList },
  "editor.open_file": { scope: "editor.control", definition: EditorOpenFile },
  "editor.ask_chat": { scope: "editor.control", definition: EditorAskChat },
  "agent.start": { scope: "agents.control", definition: AgentStart },
  "agent.prompt": { scope: "agents.control", definition: AgentPrompt },
  "agent.cancel": { scope: "agents.control", definition: AgentCancel },
  "agent.list": { scope: "agents.read", definition: AgentList },
  "agent.resume": { scope: "agents.control", definition: AgentResume },
  "agent.archive": { scope: "agents.control", definition: AgentArchive },
  "approval.respond": { scope: "agents.control", definition: ApprovalRespond },
  "terminal.list": { scope: "terminals.read", definition: TerminalList },
  "terminal.create": { scope: "terminals.control", definition: TerminalCreate },
  "terminal.write": { scope: "terminals.control", definition: TerminalWrite },
  "terminal.snapshot": { scope: "terminals.read", definition: TerminalSnapshotCmd },
  "terminal.resize": { scope: "terminals.control", definition: TerminalResize },
  "terminal.kill": { scope: "terminals.control", definition: TerminalKill },
  "sync.subscribe": { scope: "events.read", definition: SyncSubscribe },
  "sync.replay": { scope: "events.read", definition: SyncReplay },
  "machine.status": { scope: "machine.read", definition: MachineStatus },
  "machine.keep_awake": { scope: "machine.control", definition: MachineKeepAwake },
  "device.rotate_token": { scope: "device.self_manage", definition: DeviceRotateToken },
  "notify.register": { scope: "notifications.manage", definition: NotifyRegister },
  "notify.test": { scope: "notifications.manage", definition: NotifyTest },
};

const PRIVILEGED_COMMANDS = new Set([
  "git.stage",
  "git.unstage",
  "git.commit",
  "editor.open_file",
  "editor.ask_chat",
  "agent.start",
  "agent.prompt",
  "agent.cancel",
  "agent.resume",
  "agent.archive",
  "approval.respond",
  "terminal.create",
  "terminal.write",
  "terminal.resize",
  "terminal.kill",
  "machine.keep_awake",
  "device.rotate_token",
  "notify.register",
  "notify.test",
]);

export interface DispatcherDeps {
  machineId: string;
  fsService: FilesystemService;
  fsIndex: FsIndex;
  eventStore: EventStore;
  health: HealthMonitor;
  keepAwake: KeepAwake;
  git: GitService;
  editors: EditorRegistry;
  agents: AgentManager;
  terminals: TerminalManager;
  /** S7b: push-token registry (paired-device notifications) */
  devices?: DeviceStore;
  /** S7: advertised to paired phones via machine.status (over E2EE) */
  relay?: { url: string; token: string };
  /** Persistent, redacted record of privileged requests. */
  audit?: AuditLog;
}

/**
 * Transport-agnostic protocol router: raw wire JSON in, wire JSON out.
 * Reused later by the relay transport in S7 — sockets stay dumb.
 */
export class ControllerDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  async handle(raw: string, ctx: ClientContext): Promise<string[]> {
    const parsed = parseInbound(raw);
    if (!parsed.ok) {
      return [
        JSON.stringify(HelloReject.create({ error: parsed.error, supported: SUPPORTED_VERSIONS })),
      ];
    }
    return (await this.#dispatch(parsed.value, ctx)).map((m) => JSON.stringify(m));
  }

  async #dispatch(msg: KnownMessage, ctx: ClientContext): Promise<unknown[]> {
    if (msg.type === "hello") {
      if (
        ctx.authenticatedDeviceId !== null &&
        msg.payload.device_id !== ctx.authenticatedDeviceId
      ) {
        return [
          HelloReject.create({
            error: protocolError("FORBIDDEN", "hello identity does not match the paired device"),
            supported: SUPPORTED_VERSIONS,
          }),
        ];
      }
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
      ctx.deviceId = ctx.authenticatedDeviceId ?? msg.payload.device_id;
      if (ctx.authenticatedDeviceId && ctx.authenticatedTransport) {
        this.deps.devices?.markSeen(ctx.authenticatedDeviceId, ctx.authenticatedTransport);
      }
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
    if (ctx.authenticatedDeviceId && ctx.authenticatedTransport) {
      this.deps.devices?.markSeen(ctx.authenticatedDeviceId, ctx.authenticatedTransport);
    }
    const scoped = SCOPED_COMMANDS[msg.type];
    const commandId =
      "command_id" in msg && typeof msg.command_id === "string" ? msg.command_id : null;
    if (scoped && commandId && !hasClientScope(ctx, scoped.scope)) {
      this.#audit(ctx, msg, "denied_scope");
      return [
        scoped.definition.createError(
          commandId,
          protocolError("FORBIDDEN", `this paired device does not have ${scoped.scope} access`),
        ),
      ];
    }
    this.#audit(ctx, msg, "accepted");
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
      case "file.read":
        return [await this.#readFile(msg)];
      case "git.status":
        return [
          await this.#git(msg.command_id, GitStatus, () =>
            this.deps.git.status(msg.payload.project_id),
          ),
        ];
      case "git.diff_file":
        return [
          await this.#git(msg.command_id, GitDiffFile, () =>
            this.deps.git.diffFile(msg.payload.project_id, msg.payload.path, msg.payload.staged),
          ),
        ];
      case "git.stage":
        return [
          await this.#git(msg.command_id, GitStage, () =>
            this.deps.git.stage(msg.payload.project_id, msg.payload.paths),
          ),
        ];
      case "git.unstage":
        return [
          await this.#git(msg.command_id, GitUnstage, () =>
            this.deps.git.unstage(msg.payload.project_id, msg.payload.paths),
          ),
        ];
      case "git.commit":
        return [
          await this.#git(msg.command_id, GitCommit, () =>
            this.deps.git.commit(msg.payload.project_id, msg.payload.message),
          ),
        ];
      case "editor.publish_state":
        return [
          EditorPublishState.createOk(msg.command_id, {
            accepted: this.deps.editors.publish(ctx, msg.payload.state),
          }),
        ];
      case "editor.list":
        return [EditorList.createOk(msg.command_id, { editors: this.deps.editors.list() })];
      case "editor.open_file": {
        const delivered = this.deps.editors.deliver(
          msg.payload.project_id,
          JSON.stringify(
            EditorOpenRequested.create("editor", 0, {
              project_id: msg.payload.project_id,
              relative_path: msg.payload.relative_path,
              line: msg.payload.line ?? null,
            }),
          ),
        );
        return [EditorOpenFile.createOk(msg.command_id, { delivered })];
      }
      case "editor.ask_chat": {
        const delivered = this.deps.editors.deliver(
          msg.payload.project_id,
          JSON.stringify(
            EditorChatRequested.create("editor", 0, {
              project_id: msg.payload.project_id,
              query: msg.payload.query,
            }),
          ),
        );
        return [EditorAskChat.createOk(msg.command_id, { delivered })];
      }
      case "agent.start":
        return [
          await this.#tryRun(msg.command_id, AgentStart, async () => ({
            session: await this.deps.agents.start(
              msg.payload.project_id,
              msg.payload.provider,
              msg.payload.prompt,
            ),
          })),
        ];
      case "agent.prompt":
        {
          const cached = this.deps.eventStore.getCommandResult(msg.command_id);
          if (cached !== undefined) {
            return [
              AgentPrompt.createOk(
                msg.command_id,
                cached as { accepted: boolean; queued: boolean; queued_prompt_count: number },
                { duplicate: true },
              ),
            ];
          }
        }
        return [
          await this.#tryRun(msg.command_id, AgentPrompt, async () => {
            const result = await this.deps.agents.prompt(
              msg.payload.session_id,
              msg.payload.prompt,
            );
            this.deps.eventStore.putCommandResult(msg.command_id, result, 24 * 60 * 60 * 1000);
            return result;
          }),
        ];
      case "agent.cancel":
        return [
          await this.#tryRun(msg.command_id, AgentCancel, async () => ({
            cancelled: await this.deps.agents.cancel(msg.payload.session_id),
          })),
        ];
      case "agent.list":
        return [
          await this.#tryRun(msg.command_id, AgentList, async () => ({
            sessions: this.deps.agents.list(),
            providers: await this.deps.agents.providers(),
            external: await this.deps.agents.externalSessions(),
          })),
        ];
      case "agent.resume":
        return [
          await this.#tryRun(msg.command_id, AgentResume, async () => ({
            session: await this.deps.agents.resume(msg.payload.provider, msg.payload.native_id),
          })),
        ];
      case "agent.archive":
        return [
          await this.#tryRun(msg.command_id, AgentArchive, async () => ({
            archived: await this.deps.agents.archive(msg.payload.session_id),
          })),
        ];
      case "approval.respond":
        return [
          await this.#tryRun(msg.command_id, ApprovalRespond, async () => ({
            resolved: this.deps.agents.respond(msg.payload.approval_id, msg.payload.option_id),
          })),
        ];
      case "terminal.list":
        return [
          await this.#tryRun(msg.command_id, TerminalList, async () => ({
            terminals: this.deps.terminals.list(),
            shells: this.deps.terminals.shells().map((s) => ({ id: s.id, label: s.label })),
          })),
        ];
      case "terminal.create":
        return [
          await this.#tryRun(msg.command_id, TerminalCreate, async () => {
            const root = msg.payload.project_id
              ? this.deps.fsIndex.getProjectRoot(msg.payload.project_id)
              : undefined;
            return {
              terminal: this.deps.terminals.create({
                cwd: root ?? process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(),
                ...(msg.payload.shell !== undefined ? { shell: msg.payload.shell } : {}),
                ...(msg.payload.cols !== undefined ? { cols: msg.payload.cols } : {}),
                ...(msg.payload.rows !== undefined ? { rows: msg.payload.rows } : {}),
              }),
            };
          }),
        ];
      case "terminal.write":
        return [
          await this.#tryRun(msg.command_id, TerminalWrite, async () => ({
            written: this.deps.terminals.write(msg.payload.terminal_id, msg.payload.data),
          })),
        ];
      case "terminal.snapshot":
        return [
          await this.#tryRun(msg.command_id, TerminalSnapshotCmd, async () =>
            this.deps.terminals.snapshot(msg.payload.terminal_id, msg.payload.max_lines),
          ),
        ];
      case "terminal.resize":
        return [
          await this.#tryRun(msg.command_id, TerminalResize, async () => ({
            resized: this.deps.terminals.resize(
              msg.payload.terminal_id,
              msg.payload.cols,
              msg.payload.rows,
            ),
          })),
        ];
      case "terminal.kill":
        return [
          await this.#tryRun(msg.command_id, TerminalKill, async () => ({
            killed: this.deps.terminals.kill(msg.payload.terminal_id),
          })),
        ];
      case "sync.subscribe": {
        const denied = msg.payload.streams.find((stream) => !canAccessStream(ctx, stream));
        if (denied) {
          return [
            SyncSubscribe.createError(
              msg.command_id,
              protocolError("FORBIDDEN", `this paired device cannot access stream: ${denied}`),
            ),
          ];
        }
        for (const stream of msg.payload.streams) ctx.subscriptions.add(stream);
        return [SyncSubscribe.createOk(msg.command_id, { subscribed: [...ctx.subscriptions] })];
      }
      case "sync.replay": {
        const { stream, since, limit } = msg.payload;
        if (!canAccessStream(ctx, stream)) {
          return [
            SyncReplay.createError(
              msg.command_id,
              protocolError("FORBIDDEN", `this paired device cannot access stream: ${stream}`),
            ),
          ];
        }
        return [
          SyncReplay.createOk(msg.command_id, {
            events: this.deps.eventStore.read(stream, since, limit),
            head_seq: this.deps.eventStore.headSeq(stream),
          }),
        ];
      }
      case "sys.ping":
        return [SysPing.createOk(msg.command_id, { pong: nowIso() })];
      case "machine.status": {
        const device = ctx.authenticatedDeviceId
          ? this.deps.devices?.get(ctx.authenticatedDeviceId)
          : undefined;
        const relay =
          this.deps.relay && ctx.authenticatedDeviceId
            ? {
                url: this.deps.relay.url,
                tickets: issueRelayTicketBundle(this.deps.relay.token, {
                  machineId: this.deps.machineId,
                  deviceId: ctx.authenticatedDeviceId,
                }),
              }
            : null;
        return [
          MachineStatus.createOk(msg.command_id, {
            ...this.deps.health.latest(),
            keep_awake: this.deps.keepAwake.state(),
            scopes: [...(ctx.authenticatedScopes ?? ["*"])],
            device_token_expires_at: device ? new Date(device.expires_at).toISOString() : null,
            relay,
          }),
        ];
      }
      case "machine.keep_awake": {
        const state = msg.payload.enabled
          ? this.deps.keepAwake.enable(msg.payload.ttl_minutes)
          : this.deps.keepAwake.disable();
        return [MachineKeepAwake.createOk(msg.command_id, state)];
      }
      case "device.rotate_token": {
        const deviceId = ctx.authenticatedDeviceId;
        const device = deviceId ? this.deps.devices?.get(deviceId) : undefined;
        if (!deviceId || !device || device.revoked || device.expires_at <= Date.now()) {
          return [
            DeviceRotateToken.createError(
              msg.command_id,
              protocolError("FORBIDDEN", "a valid paired device connection is required"),
            ),
          ];
        }
        const issued = issueToken(device.device_id, device.scopes, DEVICE_TOKEN_TTL_MS);
        if (
          !this.deps.devices?.rotateToken(
            device.device_id,
            issued.record.token_hash,
            issued.record.expires_at,
          )
        ) {
          return [
            DeviceRotateToken.createError(
              msg.command_id,
              protocolError("INTERNAL", "could not rotate the paired device token"),
            ),
          ];
        }
        return [
          DeviceRotateToken.createOk(msg.command_id, {
            token: issued.token,
            expires_at: new Date(issued.record.expires_at).toISOString(),
          }),
        ];
      }
      case "notify.register": {
        if (!this.deps.devices || !ctx.deviceId) {
          return [
            NotifyRegister.createError(
              msg.command_id,
              protocolError("FORBIDDEN", "no device identity on this connection"),
            ),
          ];
        }
        this.deps.devices.setPushToken(ctx.deviceId, msg.payload.expo_push_token);
        return [NotifyRegister.createOk(msg.command_id, { registered: true })];
      }
      case "notify.test": {
        const token = ctx.deviceId ? this.deps.devices?.pushTokenOf(ctx.deviceId) : undefined;
        if (!token) {
          return [
            NotifyTest.createError(
              msg.command_id,
              protocolError("NOT_FOUND", "no push token registered for this device"),
            ),
          ];
        }
        const tickets = await sendExpoPush([token], {
          title: "rdc test notification",
          body: "Push pipeline works end-to-end.",
        });
        const ticket = tickets[0];
        return [
          NotifyTest.createOk(msg.command_id, {
            sent: ticket?.status === "ok",
            ticket: JSON.stringify(ticket ?? {}),
          }),
        ];
      }
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

  /** Uniform wrapper: domain failures surface as command errors, never crash the socket. */
  async #tryRun<TResult>(
    commandId: string,
    def: {
      createOk(id: string, result: TResult): unknown;
      createError(id: string, error: ReturnType<typeof protocolError>): unknown;
    },
    run: () => Promise<TResult>,
  ): Promise<unknown> {
    try {
      return def.createOk(commandId, await run());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return def.createError(commandId, protocolError("INTERNAL", message));
    }
  }

  /** Keep audit metadata useful but never persist prompts, shell input, tokens, or source data. */
  #audit(ctx: ClientContext, msg: KnownMessage, outcome: "accepted" | "denied_scope"): void {
    if (!this.deps.audit || !PRIVILEGED_COMMANDS.has(msg.type)) return;
    const payload = msg.payload as Record<string, unknown>;
    const details: Record<string, string> = {
      outcome,
      connection: ctx.authenticatedDeviceId === null ? "local_owner" : "paired_device",
    };
    for (const key of ["project_id", "session_id", "approval_id"] as const) {
      const value = payload[key];
      if (typeof value === "string") details[key] = value;
    }
    this.deps.audit.append({
      ts: nowIso(),
      actor: ctx.authenticatedDeviceId ?? ctx.deviceId ?? "local_owner",
      action: msg.type,
      details,
    });
  }

  /** Uniform wrapper: git failures surface as GIT_ERROR command errors, never crash the socket. */
  async #git<TResult>(
    commandId: string,
    def: {
      createOk(id: string, result: TResult): unknown;
      createError(id: string, error: ReturnType<typeof protocolError>): unknown;
    },
    run: () => Promise<TResult>,
  ): Promise<unknown> {
    try {
      return def.createOk(commandId, await run());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return def.createError(commandId, protocolError("GIT_ERROR", message));
    }
  }

  /** PLAN §7: canonicalize → sensitive-deny → capped read → binary detection. */
  async #readFile(msg: Extract<KnownMessage, { type: "file.read" }>): Promise<unknown> {
    const { project_id, relative_path, max_bytes } = msg.payload;
    const root = this.deps.fsIndex.getProjectRoot(project_id);
    if (root === undefined) {
      return FileRead.createError(
        msg.command_id,
        protocolError("NOT_FOUND", `unknown project: ${project_id}`),
      );
    }
    const resolved = await resolveInsideProject(root, relative_path);
    if (!resolved.ok) {
      return FileRead.createError(
        msg.command_id,
        protocolError("FORBIDDEN", resolved.error.message),
      );
    }
    if (isSensitivePath(resolved.value.rel)) {
      return FileRead.createError(
        msg.command_id,
        protocolError("FORBIDDEN", "sensitive file — viewing requires the approval flow (S4)"),
      );
    }
    try {
      const handle = await open(resolved.value.abs, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          return FileRead.createError(
            msg.command_id,
            protocolError("INVALID_PAYLOAD", "not a regular file"),
          );
        }
        const toRead = Math.min(stat.size, max_bytes);
        const buffer = Buffer.alloc(toRead);
        await handle.read(buffer, 0, toRead, 0);
        const isBinary = buffer.subarray(0, 8192).includes(0);
        return FileRead.createOk(msg.command_id, {
          relative_path: resolved.value.rel,
          size: stat.size,
          encoding: isBinary ? "base64" : "utf8",
          content: isBinary ? buffer.toString("base64") : buffer.toString("utf8"),
          truncated: stat.size > toRead,
        });
      } finally {
        await handle.close();
      }
    } catch (cause) {
      return FileRead.createError(
        msg.command_id,
        protocolError("NOT_FOUND", `cannot read ${path.basename(relative_path)}: ${String(cause)}`),
      );
    }
  }
}

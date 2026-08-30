import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { copilotAdapter } from "@rdc/agent-acp";
import { SqliteEventStore } from "@rdc/event-store";
import { detectProjects, FilesystemService, FsIndex } from "@rdc/filesystem";
import { GitService } from "@rdc/git";
import { TerminalManager } from "@rdc/terminal";
import { Command } from "commander";
import pino from "pino";
import { AgentManager } from "./agent-manager.ts";
import { AuditLog } from "./audit-log.ts";
import { configDir, loadOrCreateConfig } from "./config.ts";
import { DeviceStore } from "./device-store.ts";
import { runDoctor } from "./doctor.ts";
import { EditorRegistry } from "./editors.ts";
import { KeepAwake } from "./keep-awake.ts";
import { loadOrCreateKeys } from "./keys.ts";
import { HealthMonitor } from "./machine-health.ts";
import { PairingCoordinator } from "./pairing-coordinator.ts";
import { RelayClient } from "./relay-client.ts";
import { buildServer } from "./server.ts";
import { SessionStore } from "./session-store.ts";
import { acquireSingleInstanceLock } from "./single-instance.ts";
import { VsCodeChatReader } from "./vscode-chats.ts";

const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

async function start(): Promise<void> {
  const dir = configDir();
  const config = loadOrCreateConfig(dir);
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  const logger = pino(
    { level: config.log_level },
    pino.multistream([
      { stream: process.stdout },
      { stream: pino.destination({ dest: path.join(dir, "logs", "controller.log"), mkdir: true }) },
    ]),
  );

  const releaseLock = acquireSingleInstanceLock(dir);
  const keys = loadOrCreateKeys(dir);
  const devices = new DeviceStore(path.join(dir, "devices.db"));
  const audit = new AuditLog(path.join(dir, "audit.db"));
  const pairing = new PairingCoordinator({
    keys,
    devices,
    machineId: config.machine_id,
    machineName: os.hostname(),
  });
  const eventStore = new SqliteEventStore(path.join(dir, "events.db"));
  const fsIndex = new FsIndex(path.join(dir, "index.db"));
  const fsService = new FilesystemService(fsIndex, eventStore);
  const health = new HealthMonitor({ projectRoots: config.project_roots });
  health.start();
  const keepAwake = new KeepAwake();
  // survive controller restarts: restore the user's keep-awake intent
  const awakeFile = path.join(dir, "keepawake.json");
  keepAwake.onChange((state) => {
    try {
      writeFileSync(awakeFile, JSON.stringify({ enabled: state.enabled, until: state.until }));
    } catch {
      // best effort
    }
  });
  try {
    const saved = JSON.parse(readFileSync(awakeFile, "utf8")) as {
      enabled?: boolean;
      until?: string | null;
    };
    if (saved.enabled) {
      const remaining = saved.until ? (Date.parse(saved.until) - Date.now()) / 60_000 : undefined;
      if (remaining === undefined) keepAwake.enable();
      else if (remaining > 0) keepAwake.enable(Math.ceil(remaining));
    }
  } catch {
    // no saved state
  }
  const agents = new AgentManager(
    {
      eventStore,
      fsIndex,
      sessions: new SessionStore(path.join(dir, "sessions.db")),
      vscodeChats: new VsCodeChatReader(),
    },
    [copilotAdapter()],
  );
  const terminals = new TerminalManager();

  logger.info({ roots: config.project_roots }, "detecting projects");
  const git = new GitService();
  const detected = await detectProjects(config.project_roots);
  for (const project of detected) {
    const files = await fsService.addProject(project);
    await fsService.startWatching(project.project_id);
    if (project.vcs === "git") {
      git.register({ project_id: project.project_id, root_path: project.root_path });
      git
        .watch(project.project_id)
        .catch((cause) => logger.warn({ cause: String(cause) }, "git watch failed"));
    }
    logger.info({ project: project.name, files, id: project.project_id }, "indexed + watching");
  }

  const reconcileTimer = setInterval(() => {
    for (const project of detected) {
      fsService
        .reconcile(project.project_id)
        .then((n) => n > 0 && logger.info({ project: project.name, changes: n }, "reconciled"))
        .catch((cause) => logger.warn({ cause: String(cause) }, "reconcile failed"));
    }
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();

  // env overrides let local probes point at a scratch relay without touching config
  const relayUrl = process.env.RDC_RELAY_URL ?? config.relay?.url;
  const relayToken = process.env.RDC_RELAY_TOKEN ?? config.relay?.token;
  const relay = relayUrl && relayToken ? { url: relayUrl, token: relayToken } : undefined;

  const { app, attachProtocolSocket } = await buildServer({
    machineId: config.machine_id,
    machineName: os.hostname(),
    localToken: config.local_token,
    keys,
    devices,
    pairing,
    fsService,
    fsIndex,
    eventStore,
    health,
    keepAwake,
    git,
    editors: new EditorRegistry(),
    agents,
    terminals,
    audit,
    ...(relay ? { relay } : {}),
    ...(config.data_password
      ? {
          dataConsole: {
            password: config.data_password,
            dataDir: dir,
            ...(config.analytics ? { analytics: config.analytics } : {}),
          },
        }
      : {}),
  });
  await app.listen({ port: config.port, host: config.lan ? "0.0.0.0" : "127.0.0.1" });

  // content-free platform lifecycle ping to our own analytics (best effort)
  if (config.analytics) {
    fetch(`${config.analytics.url.replace(/\/$/, "")}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.analytics.token}`,
      },
      body: JSON.stringify({ kind: "platform_up", detail: `controller ${process.platform}` }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  let relayClient: RelayClient | null = null;
  if (relay) {
    relayClient = new RelayClient({
      url: relay.url,
      relayToken: relay.token,
      machineId: config.machine_id,
      devices,
      attach: (socket, device) => attachProtocolSocket(socket, device ?? undefined, "relay"),
      log: (msg, extra) => logger.info(extra ?? {}, msg),
    });
    relayClient.start();
    logger.info({ relay: relay.url }, "relay tunnel enabled");
  }

  const dashUrl = `http://127.0.0.1:${config.port}/dash?token=${config.local_token}`;
  logger.info({ port: config.port, projects: detected.length }, "controller ready");
  console.log(`\n  rdc controller ready — ${detected.length} project(s) indexed`);
  console.log(`  Dashboard: ${dashUrl}\n`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    clearInterval(reconcileTimer);
    relayClient?.stop();
    health.stop();
    // preserve the user's intent across restarts: disable the OS assertion
    // (auto-cleared anyway) but re-save the pre-shutdown desired state
    const desired = keepAwake.state();
    keepAwake.disable();
    try {
      writeFileSync(awakeFile, JSON.stringify({ enabled: desired.enabled, until: desired.until }));
    } catch {
      // best effort
    }
    await agents.stop();
    await terminals.stop();
    await git.stop();
    await app.close();
    await fsService.stop();
    eventStore.close();
    fsIndex.close();
    audit.close();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const program = new Command();
program.name("rdc").description("remote-dev-control local controller").version("0.0.1");
program.command("start", { isDefault: true }).description("run the controller").action(start);
program
  .command("doctor")
  .description("environment sanity checks")
  .action(async () => {
    process.exitCode = await runDoctor();
  });
await program.parseAsync();

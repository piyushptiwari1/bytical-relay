import { mkdirSync } from "node:fs";
import path from "node:path";
import { SqliteEventStore } from "@rdc/event-store";
import { detectProjects, FilesystemService, FsIndex } from "@rdc/filesystem";
import { Command } from "commander";
import pino from "pino";
import { configDir, loadOrCreateConfig } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { buildServer } from "./server.ts";
import { acquireSingleInstanceLock } from "./single-instance.ts";

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
  const eventStore = new SqliteEventStore(path.join(dir, "events.db"));
  const fsIndex = new FsIndex(path.join(dir, "index.db"));
  const fsService = new FilesystemService(fsIndex, eventStore);

  logger.info({ roots: config.project_roots }, "detecting projects");
  const detected = await detectProjects(config.project_roots);
  for (const project of detected) {
    const files = await fsService.addProject(project);
    await fsService.startWatching(project.project_id);
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

  const app = await buildServer({
    machineId: config.machine_id,
    localToken: config.local_token,
    fsService,
    fsIndex,
    eventStore,
  });
  await app.listen({ port: config.port, host: "127.0.0.1" });

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
    await app.close();
    await fsService.stop();
    eventStore.close();
    fsIndex.close();
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

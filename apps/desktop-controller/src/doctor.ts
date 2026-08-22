import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { configDir, loadOrCreateConfig } from "./config.ts";

type CheckResult = { name: string; ok: boolean; detail: string };

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/** `rdc doctor` — environment sanity checks (IMPLEMENTATION-PLAN S1.1). */
export async function runDoctor(): Promise<number> {
  const checks: CheckResult[] = [];
  const dir = configDir();

  checks.push({
    name: "node",
    ok: Number(process.versions.node.split(".")[0]) >= 22,
    detail: `v${process.versions.node} (need >=22.13 for node:sqlite)`,
  });

  let config: ReturnType<typeof loadOrCreateConfig> | null = null;
  try {
    config = loadOrCreateConfig(dir);
    checks.push({ name: "config", ok: true, detail: `${dir} (machine ${config.machine_id})` });
  } catch (cause) {
    checks.push({ name: "config", ok: false, detail: String(cause) });
  }

  if (config) {
    checks.push({
      name: "port",
      ok: await portFree(config.port),
      detail: `127.0.0.1:${config.port} ${(await portFree(config.port)) ? "free" : "in use (controller already running?)"}`,
    });
    const existing = config.project_roots.filter((r) => existsSync(r));
    checks.push({
      name: "project roots",
      ok: existing.length > 0,
      detail: `${existing.length}/${config.project_roots.length} exist: ${existing.join(", ") || "none"}`,
    });
  }

  try {
    const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
    checks.push({ name: "git", ok: true, detail: version });
  } catch {
    checks.push({
      name: "git",
      ok: false,
      detail: "git not found on PATH (fingerprints degrade to path hashes)",
    });
  }

  try {
    await import("@parcel/watcher");
    checks.push({ name: "watcher", ok: true, detail: "@parcel/watcher native backend loaded" });
  } catch (cause) {
    checks.push({
      name: "watcher",
      ok: false,
      detail: `@parcel/watcher failed to load: ${String(cause)}`,
    });
  }

  for (const c of checks) {
    console.log(` ${c.ok ? "\u2713" : "\u2717"} ${c.name.padEnd(14)} ${c.detail}`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  machine_id: z.string().min(1),
  port: z.number().int().min(1024).max(65535),
  project_roots: z.array(z.string()),
  /** Local API token — DPAPI wrapping arrives with pairing in S2. */
  local_token: z.string().min(32),
  log_level: z.enum(["trace", "debug", "info", "warn", "error"]),
});
export type ControllerConfig = z.infer<typeof ConfigSchema>;

export function configDir(): string {
  const override = process.env.RDC_CONFIG_DIR;
  if (override) return override;
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "rdc");
}

function defaultProjectRoots(): string[] {
  const home = os.homedir();
  const candidates = ["source", "projects", "dev", "code", "Desktop"].map((d) =>
    path.join(home, d),
  );
  return candidates.filter((p) => existsSync(p));
}

export function loadOrCreateConfig(dir = configDir()): ControllerConfig {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  if (existsSync(file)) {
    const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data;
    throw new Error(`invalid config at ${file}: ${z.prettifyError(parsed.error)}`);
  }
  const created: ControllerConfig = {
    machine_id: `mch_${randomBytes(8).toString("hex")}`,
    port: 8347,
    project_roots: defaultProjectRoots(),
    local_token: randomBytes(32).toString("base64url"),
    log_level: "info",
  };
  writeFileSync(file, `${JSON.stringify(created, null, 2)}\n`, "utf8");
  return created;
}

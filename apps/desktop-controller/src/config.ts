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
  /** bind 0.0.0.0 so phones on the LAN can reach the controller (S2 pairing) */
  lan: z.boolean().default(true),
  /** S7 remote access: controller dials out; token optional (legacy verified tier) —
   * without it the controller self-registers a per-machine ticket secret. */
  relay: z.object({ url: z.string().min(1), token: z.string().min(16).optional() }).optional(),
  /** self-minted HMAC key for relay tickets — registered with the relay on connect */
  relay_machine_secret: z.string().min(32).optional(),
  /** owner-only /data analytics console — unset disables the page entirely */
  data_password: z.string().min(6).optional(),
  /** first-party rdc-analytics service (owner stats + platform pings) */
  analytics: z.object({ url: z.string().min(1), token: z.string().min(16) }).optional(),
});
export type ControllerConfig = z.infer<typeof ConfigSchema>;

export function configDir(): string {
  const override = process.env.RDC_CONFIG_DIR;
  if (override) return override;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "rdc");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "rdc");
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "rdc");
}

function defaultProjectRoots(): string[] {
  const home = os.homedir();
  const candidates = ["source", "projects", "dev", "code", "Desktop"].map((d) =>
    path.join(home, d),
  );
  return candidates.filter((p) => existsSync(p));
}

export const DEFAULT_RELAY_URL = "wss://ws.relay.bytical.ai";

export function loadOrCreateConfig(dir = configDir()): ControllerConfig {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  if (existsSync(file)) {
    const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success)
      throw new Error(`invalid config at ${file}: ${z.prettifyError(parsed.error)}`);
    let config = parsed.data;
    let dirty = false;
    // remote access by default — existing field configs gain the public relay
    if (!config.relay && process.env.RDC_NO_RELAY !== "1") {
      config = { ...config, relay: { url: DEFAULT_RELAY_URL } };
      dirty = true;
    }
    if (config.relay && !config.relay.token && !config.relay_machine_secret) {
      config = { ...config, relay_machine_secret: randomBytes(32).toString("base64url") };
      dirty = true;
    }
    if (dirty) writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return config;
  }
  const created: ControllerConfig = {
    machine_id: `mch_${randomBytes(8).toString("hex")}`,
    port: 8347,
    project_roots: defaultProjectRoots(),
    local_token: randomBytes(32).toString("base64url"),
    log_level: "info",
    lan: true,
    relay: { url: DEFAULT_RELAY_URL },
    relay_machine_secret: randomBytes(32).toString("base64url"),
  };
  writeFileSync(file, `${JSON.stringify(created, null, 2)}\n`, "utf8");
  return created;
}

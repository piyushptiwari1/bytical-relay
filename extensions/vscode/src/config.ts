import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ControllerTarget {
  port: number;
  token: string;
}

function configDir(): string {
  if (process.env.RDC_CONFIG_DIR) return process.env.RDC_CONFIG_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"), "rdc");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/rdc");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "rdc");
}

/** Same-user trust: the extension reads the controller's local token directly. */
export function readControllerTarget(): ControllerTarget | null {
  try {
    const raw = readFileSync(path.join(configDir(), "config.json"), "utf8");
    const parsed = JSON.parse(raw) as { port?: number; local_token?: string };
    if (typeof parsed.port !== "number" || typeof parsed.local_token !== "string") return null;
    return { port: parsed.port, token: parsed.local_token };
  } catch {
    return null;
  }
}

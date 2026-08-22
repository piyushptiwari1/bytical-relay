import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Lockfile-based single instance (stale locks from dead PIDs are reclaimed). */
export function acquireSingleInstanceLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, "controller.lock");
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid)) {
      throw new Error(`another controller instance is already running (pid ${pid})`);
    }
  }
  writeFileSync(lockFile, String(process.pid), "utf8");
  return () => {
    try {
      rmSync(lockFile, { force: true });
    } catch {
      // best effort
    }
  };
}

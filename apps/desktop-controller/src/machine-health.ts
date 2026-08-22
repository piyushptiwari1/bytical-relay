import { statfsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { MachineHealth } from "@rdc/protocol";
import { nowIso } from "@rdc/shared";
import { execa } from "execa";

interface CpuSample {
  idle: number;
  total: number;
}

function cpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function driveOf(p: string): string {
  const root = path.parse(path.resolve(p)).root; // "C:\" on Windows, "/" elsewhere
  return root.replace(/[\\/]+$/, "") || root;
}

/**
 * Machine telemetry (IMPLEMENTATION-PLAN S1.6). Samples in the background every
 * `intervalMs` so `machine.status` answers instantly from cache; async probes
 * (network latency, battery, GPU) are time-boxed and best-effort.
 */
export class HealthMonitor {
  #latest: MachineHealth | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #prevCpu: CpuSample | null = null;
  #lastLoad: number | null = null;

  constructor(
    private readonly opts: {
      projectRoots?: readonly string[];
      probeHost?: string;
      probePort?: number;
    } = {},
  ) {}

  start(intervalMs = 30_000): void {
    void this.sampleOnce();
    this.#timer = setInterval(() => void this.sampleOnce(), intervalMs);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Cached sample, or a synchronous snapshot if the first sample hasn't landed yet. */
  latest(): MachineHealth {
    return this.#latest ?? this.quickSnapshot();
  }

  /** Sync-only snapshot: no network/battery/GPU probes. */
  quickSnapshot(): MachineHealth {
    const sample = cpuSample();
    if (this.#prevCpu) {
      const idleDelta = sample.idle - this.#prevCpu.idle;
      const totalDelta = sample.total - this.#prevCpu.total;
      if (totalDelta > 0) {
        this.#lastLoad = Math.min(100, Math.max(0, Math.round((1 - idleDelta / totalDelta) * 100)));
      }
    }
    this.#prevCpu = sample;

    const drives = new Set<string>([driveOf(process.env.SystemDrive ?? os.homedir())]);
    for (const root of this.opts.projectRoots ?? []) drives.add(driveOf(root));
    const disks: MachineHealth["disks"] = [];
    for (const drive of drives) {
      try {
        const stat = statfsSync(`${drive}${path.sep}`);
        disks.push({
          drive,
          total_bytes: stat.bsize * stat.blocks,
          free_bytes: stat.bsize * stat.bfree,
        });
      } catch {
        // drive unavailable (unplugged USB, network share) — skip
      }
    }

    const cpus = os.cpus();
    return {
      machine_name: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      uptime_s: Math.floor(os.uptime()),
      cpu: {
        model: cpus[0]?.model ?? "unknown",
        cores: cpus.length || 1,
        load_percent: this.#lastLoad,
      },
      memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() },
      disks,
      network: this.#latest?.network ?? { online: false, latency_ms: null },
      battery: this.#latest?.battery ?? null,
      gpu: this.#latest?.gpu ?? null,
      sampled_at: nowIso(),
    };
  }

  async sampleOnce(): Promise<MachineHealth> {
    const base = this.quickSnapshot();
    const [network, battery, gpu] = await Promise.all([
      this.#probeNetwork(),
      this.#probeBattery(),
      this.#probeGpu(),
    ]);
    this.#latest = { ...base, network, battery, gpu, sampled_at: nowIso() };
    return this.#latest;
  }

  #probeNetwork(): Promise<MachineHealth["network"]> {
    const host = this.opts.probeHost ?? "1.1.1.1";
    const port = this.opts.probePort ?? 443;
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const socket = net.connect({ host, port, timeout: 1500 });
      const done = (online: boolean) => {
        socket.destroy();
        resolve({ online, latency_ms: online ? Date.now() - startedAt : null });
      };
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
  }

  async #probeBattery(): Promise<MachineHealth["battery"]> {
    if (process.platform !== "win32") return null;
    try {
      const { stdout } = await execa(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json",
        ],
        { timeout: 2500, reject: false },
      );
      const parsed = JSON.parse(stdout.trim()) as {
        EstimatedChargeRemaining?: number;
        BatteryStatus?: number;
      } | null;
      if (!parsed || typeof parsed.EstimatedChargeRemaining !== "number") return null;
      return {
        percent: Math.min(100, Math.max(0, parsed.EstimatedChargeRemaining)),
        charging: [2, 6, 7, 8, 9].includes(parsed.BatteryStatus ?? 0),
      };
    } catch {
      return null; // desktops have no battery
    }
  }

  async #probeGpu(): Promise<string | null> {
    try {
      const { stdout, exitCode } = await execa(
        "nvidia-smi",
        [
          "--query-gpu=name,utilization.gpu,memory.used,memory.total",
          "--format=csv,noheader,nounits",
        ],
        { timeout: 2500, reject: false },
      );
      if (exitCode !== 0) return null;
      const line = stdout.split("\n")[0]?.trim();
      if (!line) return null;
      const [name, util, memUsed, memTotal] = line.split(",").map((s) => s.trim());
      return `${name} · ${util}% · ${memUsed}/${memTotal} MiB`;
    } catch {
      return null; // no NVIDIA tooling — AMD/Intel support later
    }
  }
}

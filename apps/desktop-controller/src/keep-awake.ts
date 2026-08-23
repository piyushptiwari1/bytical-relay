import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { KeepAwakeState } from "@rdc/protocol";
import koffi from "koffi";

// SetThreadExecutionState flags (winbase.h)
const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;

export interface AwakeStrategy {
  readonly supported: boolean;
  activate(): void;
  deactivate(): void;
}

const UNSUPPORTED: AwakeStrategy = {
  supported: false,
  activate() {},
  deactivate() {},
};

class Win32Strategy implements AwakeStrategy {
  readonly supported = true;
  constructor(private readonly call: (flags: number) => number) {}
  activate(): void {
    this.call(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
  }
  deactivate(): void {
    this.call(ES_CONTINUOUS);
  }
}

/** Holds a helper process alive while enabled (caffeinate / systemd-inhibit). */
class SpawnStrategy implements AwakeStrategy {
  readonly supported = true;
  #child: ChildProcess | null = null;
  constructor(
    private readonly command: string,
    private readonly args: string[],
  ) {}
  activate(): void {
    if (this.#child) return;
    const child = spawn(this.command, this.args, { stdio: "ignore" });
    child.on("error", () => {
      if (this.#child === child) this.#child = null;
    });
    child.on("exit", () => {
      if (this.#child === child) this.#child = null;
    });
    this.#child = child;
  }
  deactivate(): void {
    this.#child?.kill();
    this.#child = null;
  }
}

export function defaultStrategy(): AwakeStrategy {
  if (process.platform === "win32") {
    try {
      const kernel32 = koffi.load("kernel32.dll");
      const call = kernel32.func("SetThreadExecutionState", "uint32", ["uint32"]) as (
        flags: number,
      ) => number;
      return new Win32Strategy(call);
    } catch {
      return UNSUPPORTED;
    }
  }
  if (process.platform === "darwin") {
    // -w <our pid>: the assertion self-clears if the controller dies
    return new SpawnStrategy("caffeinate", ["-i", "-s", "-w", String(process.pid)]);
  }
  const inhibit = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"].find((p) => existsSync(p));
  if (inhibit) {
    // tail --pid ties the inhibitor's lifetime to the controller process
    return new SpawnStrategy(inhibit, [
      "--what=idle:sleep",
      "--who=rdc",
      "--why=agents running",
      "--mode=block",
      "tail",
      `--pid=${process.pid}`,
      "-f",
      "/dev/null",
    ]);
  }
  return UNSUPPORTED;
}

/**
 * Prevents system sleep while enabled (phone toggle, PLAN §1 item 30).
 * Windows: SetThreadExecutionState (per-process, auto-clears on exit).
 * macOS: caffeinate. Linux: systemd-inhibit. Display sleep stays allowed —
 * only the system is kept awake for agents. The strategy is re-asserted every
 * 60s while enabled (survives resume-from-sleep clearing the flag), and the
 * desired state can be persisted/restored across controller restarts.
 */
export class KeepAwake {
  readonly #strategy: AwakeStrategy;
  #enabled = false;
  #until: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #reassert: ReturnType<typeof setInterval> | null = null;
  #onChange: ((state: KeepAwakeState) => void) | null = null;

  constructor(strategy?: AwakeStrategy) {
    this.#strategy = strategy ?? defaultStrategy();
  }

  /** Called on every enable/disable — used to persist desired state. */
  onChange(listener: (state: KeepAwakeState) => void): void {
    this.#onChange = listener;
  }

  get supported(): boolean {
    return this.#strategy.supported;
  }

  state(): KeepAwakeState {
    return {
      supported: this.supported,
      enabled: this.#enabled,
      until: this.#until === null ? null : new Date(this.#until).toISOString(),
    };
  }

  enable(ttlMinutes?: number): KeepAwakeState {
    if (!this.supported) return this.state();
    this.#strategy.activate();
    this.#enabled = true;
    this.#clearTimer();
    if (ttlMinutes !== undefined) {
      this.#until = Date.now() + ttlMinutes * 60_000;
      this.#timer = setTimeout(() => this.disable(), ttlMinutes * 60_000);
      (this.#timer as { unref?: () => void }).unref?.();
    } else {
      this.#until = null;
    }
    if (!this.#reassert) {
      this.#reassert = setInterval(() => {
        if (this.#enabled) this.#strategy.activate();
      }, 60_000);
      (this.#reassert as { unref?: () => void }).unref?.();
    }
    const state = this.state();
    this.#onChange?.(state);
    return state;
  }

  disable(): KeepAwakeState {
    this.#clearTimer();
    if (this.#reassert) clearInterval(this.#reassert);
    this.#reassert = null;
    if (this.supported && this.#enabled) this.#strategy.deactivate();
    this.#enabled = false;
    this.#until = null;
    const state = this.state();
    this.#onChange?.(state);
    return state;
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { KeepAwakeState } from "@rdc/protocol";

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
      // optional native module — standalone builds run without keep-awake
      const koffiModule = createRequire(import.meta.url)("koffi") as typeof import("koffi");
      const kernel32 = koffiModule.load("kernel32.dll");
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
  #autoHold = false;
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
    this.#enabled = true;
    this.#clearTimer();
    if (ttlMinutes !== undefined) {
      this.#until = Date.now() + ttlMinutes * 60_000;
      this.#timer = setTimeout(() => this.disable(), ttlMinutes * 60_000);
      (this.#timer as { unref?: () => void }).unref?.();
    } else {
      this.#until = null;
    }
    this.#settle();
    const state = this.state();
    this.#onChange?.(state);
    return state;
  }

  disable(): KeepAwakeState {
    this.#clearTimer();
    this.#enabled = false;
    this.#until = null;
    this.#settle();
    const state = this.state();
    this.#onChange?.(state);
    return state;
  }

  /** Fluidity policy: hold the machine awake while agents run or phones are
   * connected — no toggle needed. Manual enable/disable stays authoritative;
   * the hold only adds, never removes, wakefulness. */
  setAutoHold(active: boolean): void {
    if (this.#autoHold === active) return;
    this.#autoHold = active;
    this.#settle();
  }

  /** Reconcile the OS assertion with (manual || auto) without touching state(). */
  #settle(): void {
    if (!this.supported) return;
    const want = this.#enabled || this.#autoHold;
    if (want) {
      this.#strategy.activate();
      if (!this.#reassert) {
        this.#reassert = setInterval(() => this.#strategy.activate(), 60_000);
        (this.#reassert as { unref?: () => void }).unref?.();
      }
    } else {
      if (this.#reassert) clearInterval(this.#reassert);
      this.#reassert = null;
      this.#strategy.deactivate();
    }
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

import { createRequire } from "node:module";
import { spawn as ptySpawn } from "@lydell/node-pty";
import type { TerminalInfo, TerminalSnapshot } from "@rdc/protocol";
import { newEventId, nowIso, TypedEmitter } from "@rdc/shared";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { detectShells, ptyEnv, type ShellOption } from "./shells.ts";
import { snapshotBuffer } from "./snapshot.ts";

// @xterm/headless ships CJS without ESM named exports — load via require.
const { Terminal } = createRequire(import.meta.url)(
  "@xterm/headless",
) as typeof import("@xterm/headless");

interface ManagedTerminal {
  info: TerminalInfo;
  pty: ReturnType<typeof ptySpawn>;
  term: XtermTerminal;
  seq: number;
  notify: ReturnType<typeof setTimeout> | null;
}

const SCROLLBACK = 5000;

/**
 * Controller-owned persistent PTYs (IMPLEMENTATION-PLAN S5). Terminal state
 * lives in a headless xterm per PTY — phones attach/detach freely and always
 * get a full styled snapshot; output triggers a debounced ephemeral
 * `terminal.changed` ping instead of streaming raw bytes.
 */
export class TerminalManager {
  readonly emitter = new TypedEmitter<{
    changed: { terminal_id: string; seq: number };
    closed: { terminal_id: string; exit_code: number | null };
  }>();
  readonly #terminals = new Map<string, ManagedTerminal>();

  shells(): ShellOption[] {
    return detectShells();
  }

  list(): TerminalInfo[] {
    return [...this.#terminals.values()].map((t) => t.info);
  }

  create(opts: { cwd: string; shell?: string; cols?: number; rows?: number }): TerminalInfo {
    const shells = detectShells();
    const shell = shells.find((s) => s.id === opts.shell) ?? shells[0];
    if (!shell) throw new Error("no shell available on this machine");
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 32;

    const pty = ptySpawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: opts.cwd,
      env: ptyEnv(),
    });
    const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });

    const info: TerminalInfo = {
      terminal_id: `trm_${newEventId().slice(0, 13)}`,
      shell: shell.id,
      title: shell.label,
      cwd: opts.cwd,
      cols,
      rows,
      alive: true,
      created_at: nowIso(),
    };
    const managed: ManagedTerminal = { info, pty, term, seq: 0, notify: null };
    this.#terminals.set(info.terminal_id, managed);

    pty.onData((data: string) => {
      term.write(data);
      managed.seq += 1;
      if (!managed.notify) {
        managed.notify = setTimeout(() => {
          managed.notify = null;
          this.emitter.emit("changed", { terminal_id: info.terminal_id, seq: managed.seq });
        }, 80);
        (managed.notify as { unref?: () => void }).unref?.();
      }
    });
    pty.onExit(({ exitCode }: { exitCode: number }) => {
      managed.info = { ...managed.info, alive: false };
      this.emitter.emit("closed", { terminal_id: info.terminal_id, exit_code: exitCode });
    });
    return info;
  }

  write(terminalId: string, data: string): boolean {
    const managed = this.#terminals.get(terminalId);
    if (!managed?.info.alive) return false;
    managed.pty.write(data);
    return true;
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const managed = this.#terminals.get(terminalId);
    if (!managed?.info.alive) return false;
    managed.pty.resize(cols, rows);
    managed.term.resize(cols, rows);
    managed.info = { ...managed.info, cols, rows };
    return true;
  }

  snapshot(terminalId: string, maxLines?: number): TerminalSnapshot {
    const managed = this.#terminals.get(terminalId);
    if (!managed) throw new Error(`unknown terminal: ${terminalId}`);
    return snapshotBuffer(managed.term, managed.seq, maxLines);
  }

  kill(terminalId: string): boolean {
    const managed = this.#terminals.get(terminalId);
    if (!managed) return false;
    try {
      managed.pty.kill();
    } catch {
      // already dead
    }
    managed.term.dispose();
    this.#terminals.delete(terminalId);
    return true;
  }

  async stop(): Promise<void> {
    for (const id of [...this.#terminals.keys()]) this.kill(id);
  }
}

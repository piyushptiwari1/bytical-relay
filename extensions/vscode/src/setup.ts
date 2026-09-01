import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

const REPO_URL = "https://github.com/piyushptiwari1/bytical-relay.git";
const HEALTH_TIMEOUT_MS = 180_000;
const PORT = 8347;

export type ControllerMode = "external" | "managed" | "off";

/** Launches and supervises the desktop controller so setup is one click:
 * clone into extension storage → install → run → health-poll. If a controller
 * is already running (CLI users), we attach instead of spawning a duplicate. */
export class ControllerLauncher {
  #child: ChildProcess | null = null;
  #stopping = false;
  #restarts = 0;
  #recentErrors: string[] = [];
  mode: ControllerMode = "off";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly onModeChange: (mode: ControllerMode) => void,
  ) {}

  appPath(): string {
    const configured = vscode.workspace.getConfiguration("relay").get<string>("appPath");
    if (configured?.trim()) return configured.trim();
    return path.join(this.context.globalStorageUri.fsPath, "app");
  }

  async healthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const response = await fetch(`http://127.0.0.1:${PORT}/healthz`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }

  /** One-click setup: prereqs → clone/update → install → start → wait healthy. */
  async setup(): Promise<void> {
    if (await this.healthy()) {
      this.#setMode("external");
      void vscode.window.showInformationMessage(
        "Relay controller is already running — you're ready to pair your phone.",
      );
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Relay", cancellable: false },
      async (progress) => {
        progress.report({ message: "checking prerequisites…" });
        await this.#checkPrereqs();
        const dir = this.appPath();
        if (existsSync(path.join(dir, ".git"))) {
          progress.report({ message: "updating Relay…" });
          await this.#run("git", ["pull", "--ff-only"], dir).catch(() => {
            this.output.appendLine("git pull failed — continuing with the existing checkout");
          });
        } else {
          progress.report({ message: "downloading Relay (one time)…" });
          await this.#run("git", ["clone", "--depth", "1", REPO_URL, dir], undefined);
        }
        progress.report({ message: "installing dependencies (one time, a few minutes)…" });
        await this.#run(...this.#pnpm(["install", "--frozen-lockfile"]), dir);
        progress.report({ message: "starting the controller…" });
        this.start();
        const ok = await this.#waitHealthy(progress);
        if (!ok) throw new Error("controller did not become healthy — see Relay logs");
      },
    );
  }

  /** Spawn + supervise. No-op when already managed or an external one answers. */
  start(): void {
    if (this.#child) return;
    this.#stopping = false;
    const dir = this.appPath();
    if (!existsSync(dir)) {
      void vscode.window
        .showInformationMessage("Relay is not set up on this computer yet.", "Set up now")
        .then((pick) => {
          if (pick) void vscode.commands.executeCommand("relay.setup");
        });
      return;
    }
    const [cmd, args] = this.#pnpm(["--filter", "@rdc/desktop-controller", "dev"]);
    this.output.appendLine(`[launcher] ${cmd} ${args.join(" ")} (cwd ${dir})`);
    const child = spawn(cmd, args, { cwd: dir, shell: true, windowsHide: true });
    this.#child = child;
    this.#setMode("managed");
    child.stdout?.on("data", (d: Buffer) => this.output.append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      this.output.append(text);
      // keep the tail for actionable crash notifications
      this.#recentErrors = [...this.#recentErrors, ...text.split("\n")]
        .filter((l) => l.trim())
        .slice(-12);
    });
    child.on("exit", (code) => {
      this.output.appendLine(`[launcher] controller exited (${code})`);
      this.#child = null;
      if (this.#stopping) {
        this.#setMode("off");
        return;
      }
      if (this.#restarts++ < 5) {
        this.output.appendLine("[launcher] restarting in 3s…");
        setTimeout(() => this.start(), 3000);
      } else {
        this.#setMode("off");
        const hint = this.#diagnoseCrash();
        void vscode.window
          .showErrorMessage(`Relay controller keeps crashing — ${hint}`, "Show logs")
          .then((pick) => {
            if (pick) this.output.show(true);
          });
      }
    });
  }

  /** Turn the stderr tail into a next step a human can act on. */
  #diagnoseCrash(): string {
    const tail = this.#recentErrors.join("\n");
    if (/node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE|experimental-sqlite/i.test(tail))
      return "your Node.js is too old for Relay's built-in database. Install Node.js 24 LTS from nodejs.org, then run Set up again.";
    if (/EADDRINUSE/.test(tail))
      return "port 8347 is taken by another process (another Relay controller?). Stop it or reboot, then try again.";
    if (/tsx|not recognized|command not found/i.test(tail))
      return "dependencies look incomplete — run “Relay: Set up this computer” to reinstall.";
    return `last error: ${this.#recentErrors.at(-1) ?? "see the Relay output"}`;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    if (!child?.pid) {
      this.#setMode((await this.healthy()) ? "external" : "off");
      return;
    }
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
    this.#child = null;
    this.#setMode("off");
  }

  /** Attach silently on activation: external > managed-autostart > off. */
  async autoAttach(): Promise<void> {
    if (await this.healthy()) {
      this.#setMode("external");
      return;
    }
    const autoStart = vscode.workspace.getConfiguration("relay").get<boolean>("autoStart", true);
    if (autoStart && existsSync(this.appPath())) this.start();
  }

  isSetUp(): boolean {
    return existsSync(this.appPath());
  }

  /** Poll healthz until the controller answers (first boot indexes projects).
   * Aborts early when the supervisor gave up — no zombie spinners. */
  async waitUntilHealthy(timeoutMs = 120_000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await this.healthy()) return true;
      if (this.mode === "off") return false;
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  }

  #setMode(mode: ControllerMode): void {
    this.mode = mode;
    this.onModeChange(mode);
  }

  async #waitHealthy(progress: vscode.Progress<{ message?: string }>): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < HEALTH_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await this.healthy()) {
        this.#restarts = 0;
        return true;
      }
      if (this.mode === "off") return false; // supervisor gave up — stop the spinner
      progress.report({
        message: `starting the controller… ${Math.round((Date.now() - t0) / 1000)}s (first boot indexes your projects)`,
      });
    }
    return false;
  }

  #pnpm(args: string[]): [string, string[]] {
    // corepack/global pnpm when present; npx fallback needs no admin rights
    return ["npx", ["-y", "pnpm@10.28.0", ...args]];
  }

  async #checkPrereqs(): Promise<void> {
    const missing: string[] = [];
    if (!(await this.#versionOk("git", ["--version"], null))) missing.push("Git");
    // node:sqlite needs ≥23.4; require the 24 LTS so nobody lands on a crash loop
    if (!(await this.#versionOk("node", ["--version"], 24)))
      missing.push("Node.js 24 LTS or newer");
    if (missing.length > 0) {
      const pick = await vscode.window.showErrorMessage(
        `Relay needs ${missing.join(" and ")} installed first.`,
        "Get Node.js",
        "Get Git",
      );
      if (pick === "Get Node.js")
        void vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org/en/download"));
      if (pick === "Get Git")
        void vscode.env.openExternal(vscode.Uri.parse("https://git-scm.com/downloads"));
      throw new Error(`missing prerequisites: ${missing.join(", ")}`);
    }
  }

  #versionOk(cmd: string, args: string[], minMajor: number | null): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { shell: true, windowsHide: true });
      let out = "";
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => {
        if (code !== 0) return resolve(false);
        if (minMajor === null) return resolve(true);
        const major = Number(/v?(\d+)/.exec(out.trim())?.[1] ?? 0);
        resolve(major >= minMajor);
      });
    });
  }

  #run(cmd: string, args: string[], cwd: string | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      this.output.appendLine(`[setup] ${cmd} ${args.join(" ")}`);
      const child = spawn(cmd, args, { cwd, shell: true, windowsHide: true });
      child.stdout?.on("data", (d: Buffer) => this.output.append(d.toString()));
      child.stderr?.on("data", (d: Buffer) => this.output.append(d.toString()));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)),
      );
    });
  }
}

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

const REPO_URL = "https://github.com/piyushptiwari1/bytical-relay.git";
const STANDALONE_ASSET =
  "https://github.com/piyushptiwari1/bytical-relay/releases/latest/download/relay-controller-standalone.tgz";
const RELEASE_API = "https://api.github.com/repos/piyushptiwari1/bytical-relay/releases/latest";
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

  /** Contributor mode: a configured checkout runs via pnpm; everyone else gets
   * the downloaded standalone bundle on VS Code's own Node runtime. */
  #contributorPath(): string | null {
    const configured = vscode.workspace.getConfiguration("relay").get<string>("appPath");
    return configured?.trim() ? configured.trim() : null;
  }

  #standaloneDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "controller");
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

  /** One-click setup. Default: download the prebuilt controller and run it on
   * VS Code's bundled Node — no Git, no Node, no pnpm on the machine. */
  async setup(): Promise<void> {
    if (await this.healthy()) {
      this.#setMode("external");
      void vscode.window.showInformationMessage(
        "Relay controller is already running — you're ready to pair your phone.",
      );
      return;
    }
    const contributor = this.#contributorPath();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Relay", cancellable: false },
      async (progress) => {
        if (contributor) {
          await this.#setupFromCheckout(contributor, progress);
        } else {
          await this.#setupStandalone(progress);
        }
        progress.report({ message: "starting the controller…" });
        await this.start();
        const ok = await this.#waitHealthy(progress);
        if (!ok) throw new Error("controller did not become healthy — see Relay logs");
      },
    );
  }

  async #setupStandalone(progress: vscode.Progress<{ message?: string }>): Promise<void> {
    progress.report({ message: "downloading the controller (one time, ~15s)…" });
    const dir = this.#standaloneDir();
    const tgz = path.join(this.context.globalStorageUri.fsPath, "controller.tgz");
    await mkdir(dir, { recursive: true });
    const response = await fetch(STANDALONE_ASSET, { redirect: "follow" });
    if (!response.ok) throw new Error(`download failed (HTTP ${response.status})`);
    await writeFile(tgz, Buffer.from(await response.arrayBuffer()));
    progress.report({ message: "unpacking…" });
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    // bsdtar ships with Windows 10+, macOS, and Linux
    await this.#run("tar", ["-xzf", tgz, "-C", dir], undefined);
    await rm(tgz, { force: true });
    try {
      const meta = (await (await fetch(RELEASE_API)).json()) as { tag_name?: string };
      if (meta.tag_name)
        await this.context.globalState.update("relay.controllerTag", meta.tag_name);
    } catch {
      // tag bookkeeping only
    }
  }

  async #setupFromCheckout(
    dir: string,
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    progress.report({ message: "checking prerequisites…" });
    await this.#checkPrereqs();
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
  }

  /** Spawn + supervise. Attaches to an already-running controller first —
   * a VS Code reload must reconnect, never double-spawn. */
  async start(): Promise<void> {
    if (this.#child) return;
    if (await this.healthy()) {
      this.output.appendLine("[launcher] controller already running — attached");
      this.#setMode("external");
      return;
    }
    this.#stopping = false;
    const contributor = this.#contributorPath();
    const standalone = path.join(this.#standaloneDir(), "controller.mjs");
    let cmd: string;
    let args: string[];
    let cwd: string;
    let useShell: boolean;
    let env = process.env as NodeJS.ProcessEnv;
    if (contributor) {
      [cmd, args] = this.#pnpm(["--filter", "@rdc/desktop-controller", "dev"]);
      cwd = contributor;
      useShell = true;
    } else if (existsSync(standalone)) {
      // VS Code's own runtime — zero system dependencies
      cmd = process.execPath;
      args = [standalone, "start"];
      cwd = this.#standaloneDir();
      useShell = false;
      env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    } else {
      void vscode.window
        .showInformationMessage("Relay is not set up on this computer yet.", "Set up now")
        .then((pick) => {
          if (pick) void vscode.commands.executeCommand("relay.setup");
        });
      return;
    }
    this.output.appendLine(`[launcher] ${cmd} ${args.join(" ")} (cwd ${cwd})`);
    // POSIX: detached — sessions must survive VS Code reloads (Stop is explicit)
    const detached = process.platform !== "win32";
    const child = spawn(cmd, args, { cwd, shell: useShell, windowsHide: true, env, detached });
    if (detached) child.unref();
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
      // single-instance lock = a controller is ALREADY serving — attach, don't loop
      if (/another controller instance is already running/i.test(this.#recentErrors.join("\n"))) {
        this.#recentErrors = [];
        void this.healthy().then((ok) => {
          if (ok) {
            this.output.appendLine("[launcher] attached to the already-running controller");
            this.#setMode("external");
          } else if (this.#restarts++ < 5) {
            setTimeout(() => void this.start(), 3000);
          } else {
            this.#setMode("off");
          }
        });
        return;
      }
      if (this.#restarts++ < 5) {
        this.output.appendLine("[launcher] restarting in 3s…");
        setTimeout(() => void this.start(), 3000);
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
    const pid = this.#child?.pid ?? this.#lockPid();
    if (!pid) {
      this.#setMode((await this.healthy()) ? "external" : "off");
      return;
    }
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    this.#child = null;
    this.#setMode("off");
  }

  /** Controller's single-instance pidfile — lets us stop instances we didn't spawn. */
  #lockPid(): number | null {
    const dir =
      process.env.RDC_CONFIG_DIR ??
      (process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "rdc")
        : process.platform === "darwin"
          ? path.join(os.homedir(), "Library", "Application Support", "rdc")
          : path.join(
              process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
              "rdc",
            ));
    try {
      const pid = Number(readFileSync(path.join(dir, "controller.lock"), "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /** Attach silently on activation: external > managed-autostart > off. */
  async autoAttach(): Promise<void> {
    if (await this.healthy()) {
      this.#setMode("external");
      return;
    }
    const autoStart = vscode.workspace.getConfiguration("relay").get<boolean>("autoStart", true);
    if (autoStart && this.isSetUp()) void this.start();
  }

  isSetUp(): boolean {
    return (
      existsSync(path.join(this.#standaloneDir(), "controller.mjs")) ||
      this.#contributorPath() !== null
    );
  }

  /** Old controller downloads miss newer fixes — offer a one-click refresh. */
  async offerUpdateIfStale(): Promise<void> {
    if (this.#contributorPath()) return; // git checkouts update themselves via setup
    if (!existsSync(path.join(this.#standaloneDir(), "controller.mjs"))) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const meta = (await (await fetch(RELEASE_API, { signal: controller.signal })).json()) as {
        tag_name?: string;
      };
      clearTimeout(timer);
      const current = this.context.globalState.get<string>("relay.controllerTag");
      if (!meta.tag_name || meta.tag_name === current) return;
      const pick = await vscode.window.showInformationMessage(
        `Relay: a controller update is available (${current ?? "unknown"} → ${meta.tag_name}). Updating restarts the controller.`,
        "Update now",
        "Later",
      );
      if (pick === "Update now") {
        await this.stop();
        await this.setup();
      }
    } catch {
      // offline or rate-limited — try again next activation
    }
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

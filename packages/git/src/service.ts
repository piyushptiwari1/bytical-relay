import path from "node:path";
import type watcher from "@parcel/watcher";
import type { GitState } from "@rdc/protocol";
import { stableStringify, TypedEmitter } from "@rdc/shared";
import { assertSafeRepoPaths, runGit } from "./runner.ts";
import { parseStatusV2 } from "./status.ts";

export interface GitProjectRef {
  project_id: string;
  root_path: string;
}

export interface GitDiffResult {
  path: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}

const PATCH_CAP = 512 * 1024;
const DEBOUNCE_MS = 300;
/** .git paths that mean "status may have changed" (objects/ churn is ignored). */
const GIT_DIR_RELEVANT = /(^|[\\/])(HEAD|index|MERGE_HEAD|COMMIT_EDITMSG|refs[\\/])/;

/**
 * Git vertical (IMPLEMENTATION-PLAN S3.1): system git + our porcelain-v2
 * parser. Emits "status" only when the snapshot actually changed; watch
 * triggers are the .git dir (HEAD/index/refs) and worktree fs activity
 * forwarded by the caller, both debounced.
 */
export class GitService {
  readonly emitter = new TypedEmitter<{ status: GitState }>();
  readonly #roots = new Map<string, string>();
  readonly #snapshots = new Map<string, string>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #watchers = new Map<string, watcher.AsyncSubscription>();

  register(ref: GitProjectRef): void {
    this.#roots.set(ref.project_id, ref.root_path);
  }

  rootOf(projectId: string): string {
    const root = this.#roots.get(projectId);
    if (!root) throw new Error(`unknown git project: ${projectId}`);
    return root;
  }

  async status(projectId: string): Promise<GitState> {
    const { stdout } = await runGit(this.rootOf(projectId), [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
    ]);
    return parseStatusV2(stdout, projectId);
  }

  async diffFile(projectId: string, filePath: string, staged: boolean): Promise<GitDiffResult> {
    assertSafeRepoPaths([filePath]);
    const root = this.rootOf(projectId);
    let { stdout } = await runGit(root, ["diff", ...(staged ? ["--cached"] : []), "--", filePath]);
    if (stdout.length === 0 && !staged) {
      // untracked file → synthesize an add-diff (exit code 1 is expected)
      const result = await runGit(root, ["diff", "--no-index", "--", "/dev/null", filePath], {
        allowFailure: true,
      });
      stdout = result.stdout;
    }
    const binary = /^Binary files .* differ$/m.test(stdout);
    const truncated = stdout.length > PATCH_CAP;
    return {
      path: filePath,
      patch: truncated ? stdout.slice(0, PATCH_CAP) : stdout,
      binary,
      truncated,
    };
  }

  async stage(projectId: string, paths: string[]): Promise<GitState> {
    assertSafeRepoPaths(paths);
    await runGit(this.rootOf(projectId), ["add", "--", ...paths]);
    return this.refresh(projectId);
  }

  async unstage(projectId: string, paths: string[]): Promise<GitState> {
    assertSafeRepoPaths(paths);
    await runGit(this.rootOf(projectId), ["restore", "--staged", "--", ...paths]);
    return this.refresh(projectId);
  }

  async commit(projectId: string, message: string): Promise<{ oid: string; summary: string }> {
    const root = this.rootOf(projectId);
    await runGit(root, ["commit", "-m", message]);
    const { stdout } = await runGit(root, ["rev-parse", "HEAD"]);
    void this.refresh(projectId);
    return { oid: stdout.trim(), summary: message.split("\n", 1)[0] ?? message };
  }

  /** Watch the .git dir for HEAD/index/refs changes (branch switch, commit, pull…). */
  async watch(projectId: string): Promise<void> {
    const gitDir = path.join(this.rootOf(projectId), ".git");
    if (this.#watchers.has(projectId)) return;
    let mod: typeof watcher;
    try {
      mod = (await import("@parcel/watcher")).default;
    } catch {
      return; // optional native module absent — scheduleRefresh covers updates
    }
    const sub = await mod.subscribe(gitDir, (error, events) => {
      if (error) return;
      if (events.some((e) => GIT_DIR_RELEVANT.test(e.path))) this.scheduleRefresh(projectId);
    });
    this.#watchers.set(projectId, sub);
  }

  /** Worktree activity (from the fs watcher journal) also invalidates status. */
  scheduleRefresh(projectId: string): void {
    if (!this.#roots.has(projectId)) return;
    const existing = this.#timers.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#timers.delete(projectId);
      void this.refresh(projectId).catch(() => {});
    }, DEBOUNCE_MS);
    (timer as { unref?: () => void }).unref?.();
    this.#timers.set(projectId, timer);
  }

  /** Recompute; emit only on real change. Returns the fresh state. */
  async refresh(projectId: string): Promise<GitState> {
    const state = await this.status(projectId);
    const snapshot = stableStringify(state);
    if (this.#snapshots.get(projectId) !== snapshot) {
      this.#snapshots.set(projectId, snapshot);
      this.emitter.emit("status", state);
    }
    return state;
  }

  async stop(): Promise<void> {
    for (const [, timer] of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    await Promise.all([...this.#watchers.values()].map((sub) => sub.unsubscribe()));
    this.#watchers.clear();
  }
}

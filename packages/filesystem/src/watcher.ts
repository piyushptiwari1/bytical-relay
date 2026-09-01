import path from "node:path";
import type watcher from "@parcel/watcher";
import { normalizeRelPath } from "./canonical.ts";

// Native module — optional in the single-file standalone build. Without it,
// live watching is off and the boot/periodic reconciler carries the load.
let watcherModule: typeof watcher | null | undefined;
async function loadWatcher(): Promise<typeof watcher | null> {
  if (watcherModule !== undefined) return watcherModule;
  try {
    watcherModule = (await import("@parcel/watcher")).default;
  } catch {
    watcherModule = null;
  }
  return watcherModule;
}

export interface WatchedChange {
  type: "create" | "update" | "delete";
  relative_path: string;
}

export interface WatcherOptions {
  debounceMs?: number;
  maxBatch?: number;
}

/**
 * @parcel/watcher subscription with 75ms coalescing (IMPLEMENTATION-PLAN S1.4):
 * per-path dedupe; create+delete inside one window cancels out (editor temp files);
 * delete+create collapses to update.
 */
export class ProjectWatcher {
  #pending = new Map<string, WatchedChange["type"]>();
  #timer: NodeJS.Timeout | null = null;
  #subscription: watcher.AsyncSubscription | null = null;

  private constructor(
    private readonly rootAbs: string,
    private readonly onBatch: (changes: WatchedChange[]) => void,
    private readonly debounceMs: number,
    private readonly maxBatch: number,
  ) {}

  static async start(
    rootAbs: string,
    onBatch: (changes: WatchedChange[]) => void,
    opts: WatcherOptions = {},
  ): Promise<ProjectWatcher> {
    const instance = new ProjectWatcher(
      rootAbs,
      onBatch,
      opts.debounceMs ?? 75,
      opts.maxBatch ?? 500,
    );
    const mod = await loadWatcher();
    if (!mod) return instance; // degraded: reconciler-only, no live events
    instance.#subscription = await mod.subscribe(
      rootAbs,
      (error, events) => {
        if (error) return; // reconciler is the safety net for watcher hiccups
        instance.#ingest(events);
      },
      { ignore: ["node_modules", ".git", ".turbo", "dist", "build", ".next", "coverage"] },
    );
    return instance;
  }

  #ingest(events: watcher.Event[]): void {
    for (const event of events) {
      const rel = normalizeRelPath(path.relative(this.rootAbs, event.path));
      if (rel === "" || rel.startsWith("..")) continue;
      const previous = this.#pending.get(rel);
      if (previous === "create" && event.type === "delete") {
        this.#pending.delete(rel); // transient temp file — net nothing
        continue;
      }
      if (previous === "delete" && event.type === "create") {
        this.#pending.set(rel, "update");
        continue;
      }
      if (previous === "create" && event.type === "update") {
        continue; // still a create overall
      }
      this.#pending.set(rel, event.type);
    }
    if (this.#pending.size >= this.maxBatch) {
      this.#flush();
      return;
    }
    this.#timer ??= setTimeout(() => this.#flush(), this.debounceMs);
  }

  #flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#pending.size === 0) return;
    const batch = [...this.#pending.entries()].map(([relative_path, type]) => ({
      type,
      relative_path,
    }));
    this.#pending.clear();
    this.onBatch(batch);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#subscription?.unsubscribe();
    this.#subscription = null;
  }
}

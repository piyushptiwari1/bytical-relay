import { stat } from "node:fs/promises";
import path from "node:path";
import type { EventStore, StoredEvent } from "@rdc/event-store";
import { FileChanged, fsStream, type Project } from "@rdc/protocol";
import { newEventId, nowIso, TypedEmitter } from "@rdc/shared";
import type { DetectedProject } from "./detect.ts";
import { IgnoreEngine } from "./ignore.ts";
import type { AppliedChange, FsIndex } from "./index-db.ts";
import { reconcileProject } from "./reconcile.ts";
import { scanProjectTree } from "./scan.ts";
import { ProjectWatcher, type WatchedChange } from "./watcher.ts";

interface TrackedProject {
  project: DetectedProject;
  ignore: IgnoreEngine;
  watcher: ProjectWatcher | null;
}

/**
 * Orchestrates detect → index → watch → journal (IMPLEMENTATION-PLAN S1.4).
 * Every applied change becomes a `file.changed` event on stream `fs:<project_id>`,
 * whose headSeq IS the project_version. Emits stored events for live push.
 */
export class FilesystemService {
  readonly emitter = new TypedEmitter<{ events: StoredEvent[] }>();
  readonly #tracked = new Map<string, TrackedProject>();

  constructor(
    private readonly index: FsIndex,
    private readonly events: EventStore,
  ) {}

  /** Registers + fully (re)indexes a project. Initial scan does not journal events. */
  async addProject(detected: DetectedProject): Promise<number> {
    const ignore = await IgnoreEngine.forProject(detected.root_path);
    this.index.upsertProject(detected);
    const entries = await scanProjectTree(detected.root_path, ignore);
    const count = this.index.replaceProjectTree(detected.project_id, entries);
    this.#tracked.set(detected.project_id, { project: detected, ignore, watcher: null });
    return count;
  }

  async startWatching(projectId: string): Promise<void> {
    const tracked = this.#tracked.get(projectId);
    if (!tracked || tracked.watcher) return;
    tracked.watcher = await ProjectWatcher.start(tracked.project.root_path, (batch) => {
      void this.#onWatcherBatch(projectId, batch);
    });
  }

  async reconcile(projectId: string): Promise<number> {
    const tracked = this.#tracked.get(projectId);
    if (!tracked) return 0;
    const changes = await reconcileProject(
      tracked.project.root_path,
      projectId,
      this.index,
      tracked.ignore,
    );
    return this.#applyAndJournal(projectId, changes);
  }

  /** Most-recently-active first (last fs journal event ts), idle projects alphabetical. */
  projectsWithVersion(): Project[] {
    const withActivity = this.index.listProjects().map((p) => {
      const stream = fsStream(p.project_id);
      const head = this.events.headSeq(stream);
      const last = head > 0 ? this.events.read(stream, head - 1, 1)[0] : undefined;
      return {
        project: { ...p, version: head },
        lastTs: last ? Date.parse(last.ts) : 0,
      };
    });
    withActivity.sort(
      (a, b) => b.lastTs - a.lastTs || a.project.name.localeCompare(b.project.name),
    );
    return withActivity.map((entry) => entry.project);
  }

  async stop(): Promise<void> {
    for (const tracked of this.#tracked.values()) {
      await tracked.watcher?.stop();
      tracked.watcher = null;
    }
  }

  async #onWatcherBatch(projectId: string, batch: WatchedChange[]): Promise<void> {
    const tracked = this.#tracked.get(projectId);
    if (!tracked) return;
    const changes: AppliedChange[] = [];
    for (const raw of batch) {
      const enriched = await this.#enrich(tracked, raw);
      if (enriched) changes.push(enriched);
    }
    this.#applyAndJournal(projectId, changes);
  }

  /** Watcher events carry only paths — stat for kind/size, index lookup for deletes. */
  async #enrich(tracked: TrackedProject, raw: WatchedChange): Promise<AppliedChange | null> {
    const { project, ignore } = tracked;
    if (raw.type === "delete") {
      const row = this.index.getByPath(project.project_id, raw.relative_path);
      if (!row || ignore.ignores(raw.relative_path, row.kind)) return null;
      return {
        change: "delete",
        relative_path: raw.relative_path,
        kind: row.kind,
        size: 0,
        mtime_ms: 0,
      };
    }
    try {
      const st = await stat(path.join(project.root_path, raw.relative_path));
      const kind = st.isDirectory() ? ("dir" as const) : ("file" as const);
      if (ignore.ignores(raw.relative_path, kind)) return null;
      return {
        change: raw.type === "create" ? "create" : "modify",
        relative_path: raw.relative_path,
        kind,
        size: kind === "file" ? st.size : 0,
        mtime_ms: kind === "file" ? Math.floor(st.mtimeMs) : 0,
      };
    } catch {
      // vanished between event and stat — treat as delete if indexed
      return this.#enrich(tracked, { type: "delete", relative_path: raw.relative_path });
    }
  }

  #applyAndJournal(projectId: string, changes: AppliedChange[]): number {
    const applied = changes
      .map((c) => this.index.applyChange(projectId, c))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    if (applied.length === 0) return 0;
    const stored = this.events.append(
      fsStream(projectId),
      applied.map((payload) => ({
        event_id: newEventId(),
        type: FileChanged.type,
        ts: nowIso(),
        payload,
      })),
    );
    this.emitter.emit("events", stored);
    return applied.length;
  }
}

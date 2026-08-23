import { z } from "zod";

/** Detected project (PLAN §5: identity from repo fingerprint, never from path). */
export const ProjectSchema = z.object({
  project_id: z.string().min(1),
  name: z.string().min(1),
  root_path: z.string().min(1),
  vcs: z.enum(["git", "none"]),
  fingerprint: z.string().nullable(),
  wsl: z.boolean(),
  /** headSeq of the project's fs event stream = project_version (PLAN §6). */
  version: z.number().int().nonnegative(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const FileKindSchema = z.enum(["file", "dir"]);
export type FileKind = z.infer<typeof FileKindSchema>;

export const FileEntrySchema = z.object({
  file_id: z.uuid(),
  project_id: z.string().min(1),
  parent_id: z.uuid().nullable(),
  relative_path: z.string().min(1),
  name: z.string().min(1),
  kind: FileKindSchema,
  size: z.number().int().nonnegative(),
  mtime_ms: z.number().int().nonnegative(),
  /** Content hash is computed lazily starting in S2; null until then. */
  hash: z.string().nullable(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileChangeSchema = z.object({
  project_id: z.string().min(1),
  change: z.enum(["create", "modify", "delete", "move"]),
  relative_path: z.string().min(1),
  kind: FileKindSchema,
  old_path: z.string().nullable(),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

/** Stream naming convention: one fs journal per project. */
export const fsStream = (projectId: string): string => `fs:${projectId}`;

const nonNegInt = z.number().int().nonnegative();

export const KeepAwakeStateSchema = z.object({
  supported: z.boolean(),
  enabled: z.boolean(),
  until: z.iso.datetime().nullable(),
});
export type KeepAwakeState = z.infer<typeof KeepAwakeStateSchema>;

/** Best-effort machine telemetry (S1.6): nullable fields mean "not available on this machine". */
export const MachineHealthSchema = z.object({
  machine_name: z.string(),
  platform: z.string(),
  arch: z.string(),
  uptime_s: nonNegInt,
  cpu: z.object({
    model: z.string(),
    cores: z.number().int().positive(),
    load_percent: z.number().min(0).max(100).nullable(),
  }),
  memory: z.object({ total_bytes: nonNegInt, free_bytes: nonNegInt }),
  disks: z.array(z.object({ drive: z.string(), total_bytes: nonNegInt, free_bytes: nonNegInt })),
  network: z.object({ online: z.boolean(), latency_ms: z.number().nullable() }),
  battery: z.object({ percent: z.number().min(0).max(100), charging: z.boolean() }).nullable(),
  gpu: z.string().nullable(),
  sampled_at: z.iso.datetime(),
});
export type MachineHealth = z.infer<typeof MachineHealthSchema>;

// ── Git domain (S3) ──────────────────────────────────────────────────────────
/** One changed path from `git status --porcelain=v2` ("." = unmodified column). */
export const GitFileStatusSchema = z.object({
  path: z.string().min(1),
  orig_path: z.string().nullable(),
  /** staged (index) status char: M A D R C U . */
  index: z.string().length(1),
  /** worktree status char */
  worktree: z.string().length(1),
  untracked: z.boolean(),
  conflicted: z.boolean(),
});
export type GitFileStatus = z.infer<typeof GitFileStatusSchema>;

/** One schema, any producer (controller system-git today, VS Code git ext later). */
export const GitStateSchema = z.object({
  project_id: z.string().min(1),
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: nonNegInt,
  behind: nonNegInt,
  detached: z.boolean(),
  /** null on an unborn branch (no commits yet) */
  oid: z.string().nullable(),
  files: z.array(GitFileStatusSchema),
});
export type GitState = z.infer<typeof GitStateSchema>;

/** Stream naming convention for ephemeral git pushes. */
export const gitStream = (projectId: string): string => `git:${projectId}`;

// ── Editor domain (S6: VS Code extension) ─────────────────────────────
export const EditorDiagnosticsSchema = z.object({
  errors: nonNegInt,
  warnings: nonNegInt,
  infos: nonNegInt,
});
export type EditorDiagnostics = z.infer<typeof EditorDiagnosticsSchema>;

/** Live state of one editor window, published by its extension. */
export const EditorStateSchema = z.object({
  editor_id: z.string().min(1),
  app: z.string().min(1),
  workspace: z.string().nullable(),
  project_ids: z.array(z.string()),
  active_file: z
    .object({
      project_id: z.string().nullable(),
      relative_path: z.string().nullable(),
      name: z.string(),
      line: z.number().int().positive().nullable(),
    })
    .nullable(),
  diagnostics: EditorDiagnosticsSchema,
  running_tasks: z.array(z.string()),
  last_command: z
    .object({ command: z.string(), exit_code: z.number().int().nullable() })
    .nullable(),
  updated_at: z.iso.datetime(),
});
export type EditorState = z.infer<typeof EditorStateSchema>;

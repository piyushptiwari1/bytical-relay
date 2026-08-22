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

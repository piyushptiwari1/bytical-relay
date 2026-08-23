import path from "node:path";
import type { EditorState, Project } from "@rdc/protocol";
import * as vscode from "vscode";

const norm = (p: string): string =>
  path
    .resolve(p)
    .replace(/[\\/]+$/, "")
    .toLowerCase()
    .replaceAll("\\", "/");

export interface ProjectMatch {
  project_id: string;
  root: string;
}

/** Match open workspace folders to controller projects by root path. */
export function matchProjects(projects: Project[]): ProjectMatch[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => norm(f.uri.fsPath));
  const matches: ProjectMatch[] = [];
  for (const project of projects) {
    const root = norm(project.root_path);
    if (
      folders.some(
        (folder) =>
          folder === root || folder.startsWith(`${root}/`) || root.startsWith(`${folder}/`),
      )
    ) {
      matches.push({ project_id: project.project_id, root });
    }
  }
  return matches;
}

/** Map an absolute file path into a matched project (longest root wins). */
export function toProjectRelative(
  filePath: string,
  matches: ProjectMatch[],
): { project_id: string; relative_path: string } | null {
  const file = norm(filePath);
  let best: ProjectMatch | null = null;
  for (const match of matches) {
    if (file.startsWith(`${match.root}/`) && (!best || match.root.length > best.root.length)) {
      best = match;
    }
  }
  if (!best) return null;
  return { project_id: best.project_id, relative_path: file.slice(best.root.length + 1) };
}

export function fromProjectRelative(
  projectId: string,
  relativePath: string,
  matches: ProjectMatch[],
): string | null {
  const match = matches.find((m) => m.project_id === projectId);
  if (!match) return null;
  if (relativePath.split(/[\\/]/).includes("..")) return null;
  return path.join(match.root, relativePath);
}

export interface StateInputs {
  editorId: string;
  matches: ProjectMatch[];
  runningTasks: Set<string>;
  lastCommand: { command: string; exit_code: number | null } | null;
}

/** Snapshot the window's live state into the wire schema. */
export function collectState(inputs: StateInputs): EditorState {
  const active = vscode.window.activeTextEditor;
  let activeFile: EditorState["active_file"] = null;
  if (active && active.document.uri.scheme === "file") {
    const fsPath = active.document.uri.fsPath;
    const mapped = toProjectRelative(fsPath, inputs.matches);
    activeFile = {
      project_id: mapped?.project_id ?? null,
      relative_path: mapped?.relative_path ?? null,
      name: path.basename(fsPath),
      line: active.selection.active.line + 1,
    };
  }

  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const [, diagnostics] of vscode.languages.getDiagnostics()) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) errors += 1;
      else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) warnings += 1;
      else infos += 1;
    }
  }

  return {
    editor_id: inputs.editorId,
    app: "vscode",
    workspace: vscode.workspace.name ?? null,
    project_ids: inputs.matches.map((m) => m.project_id),
    active_file: activeFile,
    diagnostics: { errors, warnings, infos },
    running_tasks: [...inputs.runningTasks],
    last_command: inputs.lastCommand,
    updated_at: new Date().toISOString(),
  };
}

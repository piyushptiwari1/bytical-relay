import type { GitFileStatus, GitState } from "@rdc/protocol";

/**
 * Parser for `git status --porcelain=v2 --branch -z` (the canonical machine
 * format; VS Code's git extension parses the same). NUL-separated entries;
 * rename entries ("2") are followed by the original path as the next token.
 */
export function parseStatusV2(stdout: string, projectId: string): GitState {
  const state: GitState = {
    project_id: projectId,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    oid: null,
    files: [],
  };

  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token.length === 0) continue;

    if (token.startsWith("# branch.oid ")) {
      const oid = token.slice("# branch.oid ".length);
      state.oid = oid === "(initial)" ? null : oid;
      continue;
    }
    if (token.startsWith("# branch.head ")) {
      const head = token.slice("# branch.head ".length);
      if (head === "(detached)") state.detached = true;
      else state.branch = head;
      continue;
    }
    if (token.startsWith("# branch.upstream ")) {
      state.upstream = token.slice("# branch.upstream ".length);
      continue;
    }
    if (token.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(token);
      if (match) {
        state.ahead = Number(match[1]);
        state.behind = Number(match[2]);
      }
      continue;
    }
    if (token.startsWith("? ")) {
      state.files.push(entry(token.slice(2), null, ".", "?", true, false));
      continue;
    }
    if (token.startsWith("! ")) continue; // ignored files (not requested, but be safe)

    if (token.startsWith("1 ")) {
      const fields = token.split(" ");
      const xy = fields[1] ?? "..";
      const filePath = fields.slice(8).join(" ");
      state.files.push(entry(filePath, null, xy[0] ?? ".", xy[1] ?? ".", false, false));
      continue;
    }
    if (token.startsWith("2 ")) {
      const fields = token.split(" ");
      const xy = fields[1] ?? "..";
      const filePath = fields.slice(9).join(" ");
      const origPath = tokens[++i] ?? null;
      state.files.push(entry(filePath, origPath, xy[0] ?? ".", xy[1] ?? ".", false, false));
      continue;
    }
    if (token.startsWith("u ")) {
      const fields = token.split(" ");
      const xy = fields[1] ?? "..";
      const filePath = fields.slice(10).join(" ");
      state.files.push(entry(filePath, null, xy[0] ?? ".", xy[1] ?? ".", false, true));
    }
  }
  return state;
}

function entry(
  filePath: string,
  origPath: string | null,
  index: string,
  worktree: string,
  untracked: boolean,
  conflicted: boolean,
): GitFileStatus {
  return { path: filePath, orig_path: origPath, index, worktree, untracked, conflicted };
}

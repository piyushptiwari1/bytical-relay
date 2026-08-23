import { AcpAdapter } from "./acp-adapter.ts";

/**
 * GitHub Copilot CLI ≥1.0.80 in ACP server mode (`copilot --acp`). Shares the
 * user's existing Copilot subscription (GitHub sign-in). `--add-dir` scopes
 * file access to the project root.
 */
export const copilotAdapter = (): AcpAdapter =>
  new AcpAdapter({
    id: "copilot",
    command: "copilot",
    argsFor: (cwd) => ["--acp", "--add-dir", cwd],
    detectArgs: ["--version"],
    windowsShim: true,
  });

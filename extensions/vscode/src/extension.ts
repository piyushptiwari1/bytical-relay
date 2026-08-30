import { randomUUID } from "node:crypto";
import { AgentList, AgentStart, EditorPublishState, ProjectList } from "@rdc/protocol";
import { ControllerClient } from "@rdc/transport";
import * as vscode from "vscode";
import { readControllerTarget } from "./config.ts";
import {
  collectState,
  fromProjectRelative,
  matchProjects,
  type ProjectMatch,
  type StateInputs,
  toProjectRelative,
} from "./state.ts";

const PUBLISH_DEBOUNCE_MS = 500;

let client: ControllerClient | null = null;
let status: vscode.StatusBarItem;
let openInAgents: (() => Promise<void>) | null = null;

export function activate(context: vscode.ExtensionContext): void {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.text = "rdc: connecting…";
  status.command = "rdc.openAgents";
  status.show();
  context.subscriptions.push(status);
  context.subscriptions.push(
    vscode.commands.registerCommand("rdc.reconnect", () => start(context)),
    vscode.commands.registerCommand("rdc.openAgents", async () => {
      if (!openInAgents) {
        await vscode.window.showWarningMessage("RDC is not connected to the local controller.");
        return;
      }
      await openInAgents();
    }),
  );
  start(context);
}

export function deactivate(): void {
  client?.close();
  client = null;
  openInAgents = null;
}

function start(context: vscode.ExtensionContext): void {
  client?.close();
  client = null;
  openInAgents = null;

  const target = readControllerTarget();
  if (!target) {
    status.text = "rdc: controller not set up";
    return;
  }
  if (typeof globalThis.WebSocket !== "function") {
    status.text = "rdc: needs VS Code ≥ 1.101";
    return;
  }

  const inputs: StateInputs = {
    editorId: `vscode_${randomUUID().slice(0, 8)}`,
    matches: [],
    runningTasks: new Set(),
    lastCommand: null,
  };

  const rdc = new ControllerClient({
    url: `ws://127.0.0.1:${target.port}/ws`,
    token: target.token,
    deviceId: inputs.editorId,
    backoff: { baseMs: 1000, capMs: 30_000 },
  });
  client = rdc;

  openInAgents = async () => {
    if (client !== rdc || rdc.state !== "ready") {
      await vscode.window.showWarningMessage("RDC is reconnecting to the local controller.");
      return;
    }
    const activeFile = vscode.window.activeTextEditor?.document;
    const activeProject =
      activeFile?.uri.scheme === "file"
        ? inputs.matches.find(
            (match) =>
              match.project_id ===
              toProjectRelative(activeFile.uri.fsPath, inputs.matches)?.project_id,
          )
        : undefined;
    const project =
      activeProject ??
      (inputs.matches.length === 1 ? inputs.matches[0] : await pickProject(inputs.matches));
    if (!project) return;

    let available: Array<{ id: string; available: boolean; detail: string }>;
    try {
      const agents = await rdc.command(AgentList, {});
      available = agents.providers.filter((provider) => provider.available);
    } catch {
      await vscode.window.showErrorMessage("RDC could not load the available agents.");
      return;
    }
    if (available.length === 0) {
      await vscode.window.showWarningMessage(
        "No RDC agent provider is available on this computer.",
      );
      return;
    }
    const providerChoices = available.map((item) => ({
      label: item.id,
      description: item.detail,
      provider: item,
    }));
    const providerChoice =
      available.length === 1
        ? undefined
        : await vscode.window.showQuickPick(providerChoices, {
            placeHolder: "Choose the agent provider",
          });
    const provider = available.length === 1 ? available[0] : providerChoice?.provider;
    if (!provider) return;

    const prompt = await vscode.window.showInputBox({
      prompt: "Start an RDC agent for this workspace",
      placeHolder: "Describe the task to run on your computer",
      ignoreFocusOut: true,
    });
    if (!prompt?.trim()) return;

    try {
      const { session } = await rdc.command(
        AgentStart,
        { project_id: project.project_id, provider: provider.id, prompt: prompt.trim() },
        { timeoutMs: 60_000 },
      );
      await vscode.window.showInformationMessage(
        `RDC started ${provider.id} for this workspace. Follow session ${session.session_id} on your phone.`,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await vscode.window.showErrorMessage(`RDC could not start the agent: ${message}`);
    }
  };

  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  const publish = () => {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      publishTimer = null;
      void rdc.command(EditorPublishState, { state: collectState(inputs) }).catch(() => {});
    }, PUBLISH_DEBOUNCE_MS);
  };

  rdc.events.on("state", (state) => {
    status.text = state === "ready" ? "rdc: connected" : `rdc: ${state}`;
    if (state === "ready") {
      void rdc
        .command(ProjectList, {})
        .then((result) => {
          inputs.matches = matchProjects(result.projects);
          publish();
        })
        .catch(() => {});
    }
  });

  rdc.events.on("event", (msg) => {
    if (msg.type === "editor.open_requested") {
      void openOnDesktop(msg.payload, inputs.matches);
      return;
    }
    if (msg.type === "editor.chat_requested") {
      void vscode.commands.executeCommand("workbench.action.chat.open", {
        query: msg.payload.query,
      });
    }
  });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(publish),
    vscode.window.onDidChangeTextEditorSelection(publish),
    vscode.workspace.onDidChangeWorkspaceFolders(publish),
    vscode.languages.onDidChangeDiagnostics(publish),
    vscode.tasks.onDidStartTask((e) => {
      inputs.runningTasks.add(e.execution.task.name);
      publish();
    }),
    vscode.tasks.onDidEndTask((e) => {
      inputs.runningTasks.delete(e.execution.task.name);
      publish();
    }),
    vscode.window.onDidStartTerminalShellExecution((e) => {
      inputs.lastCommand = { command: e.execution.commandLine.value, exit_code: null };
      publish();
    }),
    vscode.window.onDidEndTerminalShellExecution((e) => {
      inputs.lastCommand = {
        command: e.execution.commandLine.value,
        exit_code: e.exitCode ?? null,
      };
      publish();
    }),
    { dispose: () => rdc.close() },
  );

  rdc.connect().catch(() => {
    status.text = "rdc: controller offline";
  });
}

async function pickProject(matches: ProjectMatch[]): Promise<ProjectMatch | undefined> {
  if (matches.length === 0) {
    await vscode.window.showWarningMessage(
      "RDC could not match this VS Code workspace to an indexed project.",
    );
    return undefined;
  }
  const choice = await vscode.window.showQuickPick(
    matches.map((match) => ({ label: vscode.workspace.asRelativePath(match.root, false), match })),
    { placeHolder: "Choose the RDC project for this agent" },
  );
  return choice?.match;
}

async function openOnDesktop(
  payload: { project_id: string; relative_path: string; line: number | null },
  matches: ProjectMatch[],
): Promise<void> {
  const absolute = fromProjectRelative(payload.project_id, payload.relative_path, matches);
  if (!absolute) return;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  if (payload.line !== null) {
    const position = new vscode.Position(payload.line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}

import { randomUUID } from "node:crypto";
import { AgentList, AgentStart, EditorPublishState, ProjectList } from "@rdc/protocol";
import { ControllerClient } from "@rdc/transport";
import * as vscode from "vscode";
import { readControllerTarget } from "./config.ts";
import { sendFeedback } from "./feedback.ts";
import { openPairPanel } from "./pair.ts";
import { ControllerLauncher } from "./setup.ts";
import { RelaySidebar } from "./sidebar.ts";
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
let launcher: ControllerLauncher;
let sidebar: RelaySidebar;
let connectionState = "connecting";

const STATE_LABEL: Record<string, string> = {
  connecting: "connecting…",
  ready: "connected",
  reconnecting: "reconnecting…",
  closed: "waiting for controller…",
};

function renderStatus(): void {
  sidebar?.update(launcher.mode, STATE_LABEL[connectionState] ?? connectionState);
  if (connectionState === "ready") {
    status.text = "$(broadcast) Relay";
    status.tooltip = "Relay: connected — click for actions";
  } else if (launcher.mode === "off") {
    status.text = "$(circle-slash) Relay";
    status.tooltip = "Relay: controller not running — click to set up or start";
  } else {
    status.text = "$(sync~spin) Relay";
    status.tooltip = `Relay: ${STATE_LABEL[connectionState] ?? connectionState}`;
  }
}

async function showMenu(context: vscode.ExtensionContext): Promise<void> {
  const running = launcher.mode !== "off";
  const items: Array<vscode.QuickPickItem & { action: () => unknown }> = [
    {
      label: "$(device-mobile) Pair phone",
      description: "scan a QR here in the editor",
      action: () => openPairPanel(context),
    },
    {
      label: "$(rocket) Open in Agents",
      description: "start an agent on this workspace that your phone can follow",
      action: () => vscode.commands.executeCommand("rdc.openAgents"),
    },
    {
      label: "$(dashboard) Open dashboard",
      description: "owner console in the browser — devices, projects, pairing",
      action: () => {
        const target = readControllerTarget();
        if (target)
          void vscode.env.openExternal(
            vscode.Uri.parse(`http://127.0.0.1:${target.port}/dash?token=${target.token}`),
          );
      },
    },
    running
      ? {
          label: "$(debug-stop) Stop controller",
          description: "phones disconnect until it starts again",
          action: () => launcher.stop(),
        }
      : {
          label: "$(play) Start controller",
          description: "background service your phone connects to",
          action: () => void launcher.start(),
        },
    {
      label: "$(cloud-download) Set up / update this computer",
      description: "download or refresh the Relay controller",
      action: () => launcher.setup(),
    },
    {
      label: "$(sync) Check for updates",
      description: "controller + extension versions",
      action: () => launcher.offerUpdateIfStale(true),
    },
    {
      label: "$(comment-discussion) Send feedback",
      description: "straight to the maintainers — no account",
      action: () => vscode.commands.executeCommand("relay.feedback"),
    },
    {
      label: "$(output) Show Relay logs",
      action: () => vscode.commands.executeCommand("relay.logs"),
    },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Relay" });
  if (pick) await pick.action();
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Relay");
  sidebar = new RelaySidebar();
  launcher = new ControllerLauncher(context, output, () => renderStatus());
  context.subscriptions.push(vscode.window.registerTreeDataProvider("relayHome", sidebar));
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = "relay.menu";
  renderStatus();
  status.show();
  context.subscriptions.push(status, output);
  context.subscriptions.push(
    vscode.commands.registerCommand("relay.setup", async () => {
      try {
        await launcher.setup();
        start(context);
        await openPairPanel(context);
      } catch (cause) {
        output.show(true);
        void vscode.window.showErrorMessage(
          `Relay setup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }),
    vscode.commands.registerCommand("relay.pair", async () => {
      // fresh machine / stopped controller must never dead-end — chain into readiness
      if (await launcher.healthy()) return openPairPanel(context);
      if (!launcher.isSetUp()) {
        const pick = await vscode.window.showInformationMessage(
          "Relay will set up this computer first (one time, a few minutes) — pairing opens automatically after.",
          { modal: true },
          "Set up & pair",
        );
        if (pick) await vscode.commands.executeCommand("relay.setup");
        return;
      }
      await launcher.start();
      const healthy = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Relay: starting the controller…",
        },
        () => launcher.waitUntilHealthy(),
      );
      if (healthy) return openPairPanel(context);
      output.show(true);
      void vscode.window.showErrorMessage(
        "Relay controller did not start — see the Relay logs for details.",
      );
    }),
    vscode.commands.registerCommand("relay.menu", () => showMenu(context)),
    vscode.commands.registerCommand("relay.feedback", () =>
      sendFeedback(String(context.extension.packageJSON.version ?? "dev")),
    ),
    vscode.commands.registerCommand("relay.stop", () => launcher.stop()),
    vscode.commands.registerCommand("relay.checkUpdates", () => launcher.offerUpdateIfStale(true)),
    vscode.commands.registerCommand("relay.logs", () => output.show(true)),
    vscode.commands.registerCommand("rdc.reconnect", () => start(context)),
    vscode.commands.registerCommand("rdc.openAgents", async () => {
      if (!openInAgents) {
        await vscode.window.showWarningMessage("Relay is not connected to the local controller.");
        return;
      }
      await openInAgents();
    }),
  );
  void launcher.autoAttach().then(async () => {
    start(context);
    void launcher.offerUpdateIfStale();
    // first-run nudge: fresh machine, nothing running — offer the one-click path
    if (
      launcher.mode === "off" &&
      !launcher.isSetUp() &&
      !context.globalState.get("relay.welcomed")
    ) {
      await context.globalState.update("relay.welcomed", true);
      const pick = await vscode.window.showInformationMessage(
        "Relay: set up this computer to pair your phone (one time, a few minutes).",
        "Set up now",
        "Later",
      );
      if (pick === "Set up now") void vscode.commands.executeCommand("relay.setup");
    }
  });
}

export function deactivate(): void {
  client?.close();
  client = null;
  openInAgents = null;
  void launcher?.stop();
}

function start(context: vscode.ExtensionContext): void {
  client?.close();
  client = null;
  openInAgents = null;

  const target = readControllerTarget();
  if (!target) {
    connectionState = "not set up";
    renderStatus();
    return;
  }
  if (typeof globalThis.WebSocket !== "function") {
    connectionState = "needs VS Code ≥ 1.101";
    renderStatus();
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
    connectionState = state;
    renderStatus();
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

  // initial connect must survive controller restarts — retry with backoff,
  // renderStatus() owns the status text (never hard-set it here)
  const tryConnect = (attempt: number) => {
    rdc.connect().catch(() => {
      if (client !== rdc) return;
      setTimeout(() => tryConnect(attempt + 1), Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4)));
    });
  };
  tryConnect(0);
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

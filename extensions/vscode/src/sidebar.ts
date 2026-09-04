import * as vscode from "vscode";
import type { ControllerMode } from "./setup.ts";

interface RowSpec {
  label: string;
  icon: string;
  command?: string;
  description?: string;
}

/** Activity-bar home: live status + every action two clicks from anywhere. */
export class RelaySidebar implements vscode.TreeDataProvider<RowSpec> {
  #emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#emitter.event;
  #mode: ControllerMode = "off";
  #connection = "connecting";

  update(mode: ControllerMode, connection: string): void {
    this.#mode = mode;
    this.#connection = connection;
    this.#emitter.fire();
  }

  getTreeItem(row: RowSpec): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label);
    item.iconPath = new vscode.ThemeIcon(row.icon);
    if (row.description) item.description = row.description;
    if (row.command) item.command = { command: row.command, title: row.label };
    return item;
  }

  getChildren(): RowSpec[] {
    const running = this.#mode !== "off";
    const status: RowSpec = running
      ? {
          label: "Controller",
          icon: this.#connection === "ready" ? "pass-filled" : "sync~spin",
          description:
            this.#connection === "ready"
              ? `running · ${this.#mode === "external" ? "attached" : "managed"}`
              : this.#connection,
          command: "relay.logs",
        }
      : {
          label: "Controller",
          icon: "circle-slash",
          description: "not running",
          command: "relay.menu",
        };
    return [
      status,
      running
        ? {
            label: "Pair phone",
            icon: "device-mobile",
            command: "relay.pair",
            description: "QR in editor",
          }
        : {
            label: "Set up this computer",
            icon: "cloud-download",
            command: "relay.setup",
            description: "one time",
          },
      {
        label: "Open in Agents",
        icon: "rocket",
        command: "rdc.openAgents",
        description: "agent your phone can follow",
      },
      {
        label: "Open dashboard",
        icon: "dashboard",
        command: "relay.menu",
        description: "owner console",
      },
      { label: "Send feedback", icon: "comment-discussion", command: "relay.feedback" },
      { label: "Check for updates", icon: "sync", command: "relay.checkUpdates" },
      { label: "Logs", icon: "output", command: "relay.logs" },
    ];
  }
}

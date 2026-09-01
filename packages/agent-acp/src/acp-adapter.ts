import { spawn } from "node:child_process";
import type {
  AdapterCallbacks,
  AgentAdapter,
  AgentSessionHandle,
  PermissionAsk,
} from "@rdc/agent-core";
import type { AgentUpdate } from "@rdc/protocol";
import { NdjsonRpc } from "./ndjson-rpc.ts";

export interface AcpAdapterConfig {
  id: string;
  command: string;
  argsFor(cwd: string): string[];
  detectArgs?: string[];
  env?: Record<string, string>;
  /** true for npm/.cmd shims (copilot) that need a shell on Windows */
  windowsShim?: boolean;
}

const quoteArg = (value: string): string =>
  /[ \t"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;

function spawnAgent(
  config: AcpAdapterConfig,
  args: string[],
  opts: { cwd?: string; stdio: ("pipe" | "ignore")[] },
): ReturnType<typeof spawn> {
  if (config.windowsShim && process.platform === "win32") {
    const commandLine = [quoteArg(config.command), ...args.map(quoteArg)].join(" ");
    return spawn(commandLine, [], {
      ...opts,
      shell: true,
      env: { ...process.env, ...config.env },
    });
  }
  return spawn(config.command, args, { ...opts, env: { ...process.env, ...config.env } });
}

interface AcpContent {
  type: string;
  text?: string;
}

interface AcpUpdateParams {
  sessionId: string;
  update: {
    sessionUpdate: string;
    content?: AcpContent;
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    entries?: Array<{ content: string; status: string }>;
  };
}

interface AcpPermissionParams {
  sessionId: string;
  toolCall?: { title?: string; kind?: string };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

/**
 * Generic ACP adapter (agentclientprotocol.com): spawn agent as JSON-RPC
 * server over stdio, one child per session. Copilot CLI, Gemini CLI, and any
 * future ACP agent ride this unchanged — only the spawn config differs.
 */
export class AcpAdapter implements AgentAdapter {
  readonly id: string;

  constructor(private readonly config: AcpAdapterConfig) {
    this.id = config.id;
  }

  async detect(): Promise<{ available: boolean; detail: string }> {
    return new Promise((resolve) => {
      const child = spawnAgent(this.config, this.config.detectArgs ?? ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve({ available: false, detail: "detect timeout" });
      }, 20_000);
      child.on("error", (cause) => {
        clearTimeout(timer);
        resolve({ available: false, detail: String(cause.message) });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ available: true, detail: output.trim().split("\n")[0] ?? "" });
        else resolve({ available: false, detail: `exit ${code}` });
      });
    });
  }

  async createSession(opts: {
    cwd: string;
    model?: string;
    callbacks: AdapterCallbacks;
  }): Promise<AgentSessionHandle> {
    return this.#boot(opts.cwd, opts.callbacks, async (rpc) => {
      if (opts.model) {
        try {
          return await rpc.request<{ sessionId: string }>("session/new", {
            cwd: opts.cwd,
            mcpServers: [],
            model: opts.model,
          });
        } catch {
          // agent rejects unknown params — fall through without the model
        }
      }
      return rpc.request<{ sessionId: string }>("session/new", { cwd: opts.cwd, mcpServers: [] });
    });
  }

  /** ACP session/load: the agent replays the full conversation as updates, then we can prompt. */
  async resumeSession(opts: {
    nativeId: string;
    cwd: string;
    callbacks: AdapterCallbacks;
  }): Promise<AgentSessionHandle> {
    return this.#boot(opts.cwd, opts.callbacks, async (rpc) => {
      await rpc.request("session/load", {
        sessionId: opts.nativeId,
        cwd: opts.cwd,
        mcpServers: [],
      });
      return { sessionId: opts.nativeId };
    });
  }

  async #boot(
    cwd: string,
    callbacks: AdapterCallbacks,
    establish: (rpc: NdjsonRpc) => Promise<{ sessionId: string }>,
  ): Promise<AgentSessionHandle> {
    const child = spawnAgent(this.config, this.config.argsFor(cwd), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.setEncoding("utf8");
    let stderrTail = "";
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    const rpc = new NdjsonRpc(child);
    let exited = false;
    child.on("exit", (code) => {
      if (exited) return;
      exited = true;
      callbacks.onExit(
        code === 0 || code === null ? null : `agent exited ${code}: ${stderrTail.trim()}`,
      );
    });

    rpc.onNotification("session/update", (params) => {
      const mapped = mapUpdate(params as AcpUpdateParams);
      if (mapped) callbacks.onUpdate(mapped);
    });

    rpc.onRequest("session/request_permission", async (params) => {
      const ask = mapPermission(params as AcpPermissionParams);
      const answer = await callbacks.onPermission(ask);
      if ("cancelled" in answer) {
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: answer.option_id } };
    });

    // fs/terminal capabilities are declined — the agent uses its own tools.
    await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const session = await establish(rpc);

    return {
      providerSessionId: session.sessionId,
      async prompt(text: string): Promise<{ stop_reason: string }> {
        const result = (await rpc.request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text }],
        })) as { stopReason?: string };
        return { stop_reason: result.stopReason ?? "end_turn" };
      },
      async cancel(): Promise<void> {
        rpc.notify("session/cancel", { sessionId: session.sessionId });
      },
      async dispose(): Promise<void> {
        exited = true;
        rpc.close();
        child.kill();
      },
    };
  }
}

function mapUpdate(params: AcpUpdateParams): AgentUpdate | null {
  const update = params.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content?.type === "text" && update.content.text
        ? { kind: "message_chunk", text: update.content.text }
        : null;
    case "agent_thought_chunk":
      return update.content?.type === "text" && update.content.text
        ? { kind: "thought_chunk", text: update.content.text }
        : null;
    case "user_message_chunk":
      return update.content?.type === "text" && update.content.text
        ? { kind: "user_message", text: update.content.text }
        : null;
    case "tool_call":
    case "tool_call_update": {
      const status =
        update.status ?? (update.sessionUpdate === "tool_call" ? "pending" : "in_progress");
      return {
        kind: "tool_call",
        tool_id: update.toolCallId ?? "tool",
        title: update.title ?? "",
        tool_kind: update.kind ?? "other",
        status: (["pending", "in_progress", "completed", "failed"].includes(status)
          ? status
          : "in_progress") as "pending" | "in_progress" | "completed" | "failed",
      };
    }
    case "plan":
      return {
        kind: "plan",
        entries: (update.entries ?? []).map((e) => ({ content: e.content, status: e.status })),
      };
    default:
      return null;
  }
}

function mapPermission(params: AcpPermissionParams): PermissionAsk {
  return {
    title: params.toolCall?.title ?? "Agent requests permission",
    tool_kind: params.toolCall?.kind ?? "other",
    options: params.options.map((o) => ({
      option_id: o.optionId,
      name: o.name,
      option_kind: o.kind,
    })),
  };
}

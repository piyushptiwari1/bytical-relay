// Live phone-simulator probe runner (WORKFLOW.md step 4).
//
//   pnpm probe                     → run default suites (status chats terminal)
//   pnpm probe all                 → every suite
//   pnpm probe chats terminal      → pick suites
//   pnpm probe resume <native_id>  → live-continue a laptop chat (consumes a Copilot turn;
//                                    auto-archives after unless --keep)
//   pnpm probe archive <session_id>
//
// Token auto-read from %LOCALAPPDATA%/rdc/config.json (override RDC_PROBE_TOKEN),
// port 8347 (override RDC_PROBE_PORT).
import { connect, ledger, sleep } from "./probe-lib.mjs";

const suites = {
  /** Controller alive, healthy, projects indexed. */
  async status(client, t) {
    await t.expect("ST1", "sys.ping answers", async () => {
      const { pong } = await client.command("sys.ping", {});
      return `pong ${pong}`;
    });
    await t.expect("ST2", "machine.status reports health", async () => {
      const status = await client.command("machine.status", {});
      return `keep_awake=${JSON.stringify(status.keep_awake)}`;
    });
    await t.expect("ST3", "projects indexed", async () => {
      const { projects } = await client.command("project.list", {});
      if (projects.length === 0) throw new Error("no projects indexed");
      return `${projects.length} projects`;
    });
  },

  /** VS Code panel chats are listed and mapped to projects. */
  async chats(client, t) {
    let external = [];
    await t.expect("CH1", "agent.list returns external sessions", async () => {
      const list = await client.command("agent.list", {});
      external = list.external;
      return `${list.sessions.length} sessions, ${external.length} external`;
    });
    await t.expect("CH2", "VS Code panel chats present", () => {
      const chats = external.filter((e) => e.provider === "vscode-chat");
      if (chats.length === 0) throw new Error("no vscode-chat entries");
      return `${chats.length} panel chats`;
    });
    await t.expect("CH3", "at least one chat mapped to a project", () => {
      const mapped = external.filter((e) => e.provider === "vscode-chat" && e.project_id);
      if (mapped.length === 0) throw new Error("no chat has a project_id");
      return `${mapped.length} mapped, e.g. "${mapped[0].title.slice(0, 40)}"`;
    });
  },

  /** Terminal round-trip: create → echo → snapshot shows it → kill. */
  async terminal(client, t) {
    const marker = `probe_ok_${Date.now() % 100000}`;
    let terminalId;
    await t.expect("TR1", "shells detected", async () => {
      const { shells } = await client.command("terminal.list", {});
      if (shells.length === 0) throw new Error("no shells");
      return shells.map((s) => s.id).join(", ");
    });
    await t.expect(
      "TR2",
      "create terminal + echo round-trip",
      async () => {
        const { terminal } = await client.command("terminal.create", { shell: "cmd" });
        terminalId = terminal.terminal_id;
        await sleep(1500);
        await client.command("terminal.write", {
          terminal_id: terminalId,
          data: `echo ${marker}\r`,
        });
        await sleep(1500);
        const snapshot = await client.command("terminal.snapshot", { terminal_id: terminalId });
        const text = snapshot.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n");
        if (!text.includes(marker)) throw new Error("echo not visible in snapshot");
        return `${snapshot.lines.length} lines, seq=${snapshot.seq}`;
      },
      { fatal: false },
    );
    if (terminalId) {
      await t.expect("TR3", "kill terminal", async () => {
        await client.command("terminal.kill", { terminal_id: terminalId });
      });
    }
  },

  /** Live-continue a laptop chat through the Copilot CLI (args: <native_id> [--keep]). */
  async resume(client, t, args) {
    const nativeId = args.find((a) => !a.startsWith("--"));
    const keep = args.includes("--keep");
    if (!nativeId) throw new Error("usage: pnpm probe resume <native_id> [--keep]");
    let sessionId;
    await t.expect(
      "RS1",
      `agent.resume ${nativeId}`,
      async () => {
        const { session } = await client.command(
          "agent.resume",
          { provider: "vscode-chat", native_id: nativeId },
          120_000,
        );
        sessionId = session.session_id;
        return `session ${sessionId} status=${session.status}`;
      },
      { fatal: true },
    );
    await t.expect("RS2", "seeded session settles to idle", async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 120_000) {
        await sleep(3000);
        const list = await client.command("agent.list", {});
        const mine = list.sessions.find((s) => s.session_id === sessionId);
        if (mine?.status === "idle") return `idle after ${Math.round((Date.now() - t0) / 1000)}s`;
        if (mine?.status === "error") throw new Error("session errored");
      }
      throw new Error("never settled to idle");
    });
    await t.expect("RS3", "journal contains imported turns", async () => {
      const replay = await client.command("sync.replay", {
        stream: `agent:${sessionId}`,
        since: 0,
        limit: 5,
      });
      if (replay.head_seq === 0) throw new Error("journal empty");
      return `head_seq=${replay.head_seq}`;
    });
    if (sessionId && !keep) {
      await t.expect("RS4", "archive probe session (cleanup)", async () => {
        const { archived } = await client.command("agent.archive", { session_id: sessionId });
        if (!archived) throw new Error("not archived");
      });
    }
  },

  /** Utility: archive a session by id (args: <session_id>). */
  async archive(client, t, args) {
    const sessionId = args[0];
    if (!sessionId) throw new Error("usage: pnpm probe archive <session_id>");
    await t.expect("AR1", `archive ${sessionId}`, async () => {
      const { archived } = await client.command("agent.archive", { session_id: sessionId });
      if (!archived) throw new Error("not archived");
    });
  },

  /** Live remote access through the relay (args: [relayUrl] [relayToken], else controller config). */
  async relay(_client, t, args) {
    const { relaySuite } = await import("./probe-relay.mjs");
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    let relayUrl = args.find((a) => a.startsWith("ws"));
    let relayToken = args.find((a) => !a.startsWith("ws") && !a.startsWith("--"));
    if (!relayUrl || !relayToken) {
      const base = process.env.LOCALAPPDATA ?? "";
      const config = JSON.parse(readFileSync(path.join(base, "rdc", "config.json"), "utf8"));
      if (!config.relay) throw new Error("no relay in controller config and none passed");
      relayUrl = relayUrl ?? config.relay.url;
      relayToken = relayToken ?? config.relay.token;
    }
    const port = process.env.RDC_PROBE_PORT ?? 8347;
    await relaySuite(t, { port, relayUrl, relayToken });
  },

  /** S7b: push-token registration + live Expo Push API round-trip. */
  async push(_client, t) {
    const { pushSuite } = await import("./probe-relay.mjs");
    await pushSuite(t, { port: process.env.RDC_PROBE_PORT ?? 8347 });
  },
};

const DEFAULT = ["status", "chats", "terminal"];

async function main() {
  const argv = process.argv.slice(2);
  const names =
    argv[0] === "all"
      ? Object.keys(suites).filter((s) => !["resume", "archive", "relay", "push"].includes(s))
      : argv.filter((a) => suites[a]);
  const chosen = names.length > 0 ? names : DEFAULT;
  const extraArgs = argv.slice(argv.findIndex((a) => suites[a]) + 1);

  const t = ledger();
  const client = await connect({ deviceId: "probe-runner" });
  try {
    for (const name of chosen) {
      console.log(`\n══ suite: ${name} ══`);
      await suites[name](client, t, extraArgs);
    }
  } finally {
    client.close();
  }
  process.exit(t.summarize());
}

main().catch((cause) => {
  console.error(`\nPROBE ABORTED: ${cause.message}`);
  process.exit(1);
});

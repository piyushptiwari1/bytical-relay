// Shared live-probe client for the WORKFLOW.md discipline. Plaintext local-token
// ws client + expectation ledger. Import from tooling/probe.mjs suites.
import { readFileSync } from "node:fs";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => globalThis.crypto.randomUUID();

/** Reads the controller's local token from %LOCALAPPDATA%/rdc/config.json (or env). */
export function localToken() {
  if (process.env.RDC_PROBE_TOKEN) return process.env.RDC_PROBE_TOKEN;
  const base =
    process.env.LOCALAPPDATA ??
    (process.platform === "darwin"
      ? path.join(process.env.HOME ?? "", "Library/Application Support")
      : path.join(process.env.HOME ?? "", ".config"));
  const config = JSON.parse(readFileSync(path.join(base, "rdc", "config.json"), "utf8"));
  return config.local_token;
}

/** Connect + hello handshake. Resolves to a client with command()/subscribe()/close(). */
export function connect({
  port = process.env.RDC_PROBE_PORT ?? 8347,
  token,
  deviceId = "probe",
} = {}) {
  const resolvedToken = token ?? localToken();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(resolvedToken)}`);
  const pending = new Map();
  const eventListeners = new Set();

  const client = {
    /** Send a command, await its .result payload (throws on error status). */
    command(type, payload = {}, timeoutMs = 30_000) {
      const command_id = rand();
      return new Promise((resolve, reject) => {
        pending.set(command_id, { resolve, reject });
        ws.send(
          JSON.stringify({
            id: rand(),
            type,
            version: 1,
            ts: new Date().toISOString(),
            command_id,
            payload,
          }),
        );
        setTimeout(() => {
          if (pending.delete(command_id)) reject(new Error(`${type} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });
    },
    /** Register a listener for non-result messages (events/pings). Returns unsubscribe. */
    onEvent(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    close() {
      ws.close();
    },
  };

  return new Promise((resolve, reject) => {
    const guard = setTimeout(
      () => reject(new Error("hello_ack timeout — is the controller running?")),
      10_000,
    );
    ws.addEventListener("error", () => {
      clearTimeout(guard);
      reject(new Error(`cannot connect to ws://127.0.0.1:${port} — is the controller running?`));
    });
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          id: rand(),
          type: "hello",
          version: 1,
          ts: new Date().toISOString(),
          payload: { protocol: { min: 1, max: 1 }, device_id: deviceId },
        }),
      );
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "hello_ack") {
        clearTimeout(guard);
        resolve(client);
        return;
      }
      if (msg.command_id && msg.type.endsWith(".result")) {
        const entry = pending.get(msg.command_id);
        if (!entry) return;
        pending.delete(msg.command_id);
        if (msg.payload.status === "ok") entry.resolve(msg.payload.result);
        else
          entry.reject(new Error(`${msg.type}: ${msg.payload.error?.message ?? "unknown error"}`));
        return;
      }
      for (const fn of eventListeners) fn(msg);
    });
  });
}

/** Expectation ledger: declare with expect(), print a PASS/FAIL table at the end. */
export function ledger() {
  const rows = [];
  return {
    /** Run one expectation. fn throws → FAIL (captured, run continues unless fatal). */
    async expect(id, description, fn, { fatal = false } = {}) {
      process.stdout.write(`\n▶ ${id}: ${description}\n`);
      try {
        const detail = await fn();
        rows.push({ id, description, ok: true, detail: detail ?? "" });
        console.log(`  ✔ ${id} OK${detail ? ` — ${detail}` : ""}`);
      } catch (cause) {
        rows.push({ id, description, ok: false, detail: cause.message });
        console.error(`  ✘ ${id} FAIL — ${cause.message}`);
        if (fatal) throw new Error(`fatal expectation ${id} failed`);
      }
    },
    /** Print summary; returns process exit code. */
    summarize() {
      console.log("\n━━━ expectation ledger ━━━");
      for (const r of rows) {
        console.log(
          ` ${r.ok ? "PASS" : "FAIL"}  ${r.id}  ${r.description}${r.detail ? ` — ${r.detail}` : ""}`,
        );
      }
      const failed = rows.filter((r) => !r.ok).length;
      console.log(
        failed === 0
          ? `\nPROBE PASS (${rows.length} expectations)`
          : `\nPROBE FAIL (${failed}/${rows.length})`,
      );
      return failed === 0 ? 0 : 1;
    },
  };
}

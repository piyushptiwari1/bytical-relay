import * as vscode from "vscode";
import { readControllerTarget } from "./config.ts";

interface PairingStatus {
  state: string;
  fingerprint?: string;
  device_name?: string;
  expires_in_s?: number;
}

/** In-editor pairing: QR + code + fingerprint confirmation, no dashboard needed.
 * The webview never sees the local token — all API calls happen extension-side. */
export async function openPairPanel(context: vscode.ExtensionContext): Promise<void> {
  const target = readControllerTarget();
  if (!target) {
    void vscode.window.showErrorMessage(
      "Relay controller is not running yet — run “Relay: Set up this computer” first.",
    );
    return;
  }
  const api = async (pathname: string, method = "POST"): Promise<Record<string, unknown>> => {
    const response = await fetch(`http://127.0.0.1:${target.port}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${target.token}` },
    });
    if (!response.ok) throw new Error(`${pathname} → ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };

  let started: { qr_data_url?: string; code?: string };
  try {
    started = (await api("/api/pairing/start")) as typeof started;
  } catch (cause) {
    void vscode.window.showErrorMessage(
      `Relay could not start pairing: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "relayPair",
    "Pair your phone",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = pairHtml(started.qr_data_url ?? "", started.code ?? "");

  let done = false;
  const timer = setInterval(() => {
    void (async () => {
      try {
        const status = (await api("/api/pairing/status", "GET")) as unknown as PairingStatus;
        void panel.webview.postMessage({ kind: "status", status });
        if (status.state === "granted") {
          done = true;
          clearInterval(timer);
          setTimeout(() => panel.dispose(), 4000);
        }
        if (["expired", "cancelled", "locked"].includes(status.state)) {
          clearInterval(timer);
        }
      } catch {
        // controller restarting — keep polling
      }
    })();
  }, 1000);

  panel.webview.onDidReceiveMessage(
    (msg: { kind?: string }) => {
      if (msg.kind === "confirm") void api("/api/pairing/confirm").catch(() => {});
      if (msg.kind === "cancel") {
        void api("/api/pairing/cancel").catch(() => {});
        panel.dispose();
      }
    },
    undefined,
    context.subscriptions,
  );
  panel.onDidDispose(() => {
    clearInterval(timer);
    if (!done) void api("/api/pairing/cancel").catch(() => {});
  });
}

function pairHtml(qrDataUrl: string, code: string): string {
  const nonce = Math.random().toString(36).slice(2);
  const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 28px; }
  img { width: 260px; height: 260px; border-radius: 12px; background: #fff; padding: 12px; }
  .code { font-size: 26px; letter-spacing: 6px; font-weight: 700; font-family: var(--vscode-editor-font-family); }
  .state { opacity: .85; min-height: 40px; text-align: center; }
  .fp { font-size: 30px; letter-spacing: 4px; }
  button { padding: 8px 22px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .ok { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .no { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-widget-border, #666); }
  .hidden { display: none; }
</style></head>
<body>
  <h2>Pair your phone</h2>
  <p>Open Relay on your phone → <b>Pair</b> → scan this code.<br/>Phone and computer must be on the same Wi-Fi for this one step.</p>
  <img alt="pairing QR" src="${qrDataUrl}">
  <div class="code">${code}</div>
  <div class="state" id="state">Waiting for your phone…</div>
  <div id="confirmRow" class="hidden">
    <div class="fp" id="fp"></div>
    <p>Check the same emoji show on the phone, then confirm.</p>
    <button class="ok" id="yes">They match — pair</button>
    <button class="no" id="no">Cancel</button>
  </div>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const state = document.getElementById("state");
    const row = document.getElementById("confirmRow");
    document.getElementById("yes").addEventListener("click", () => vscodeApi.postMessage({ kind: "confirm" }));
    document.getElementById("no").addEventListener("click", () => vscodeApi.postMessage({ kind: "cancel" }));
    window.addEventListener("message", (event) => {
      const { status } = event.data;
      if (!status) return;
      if (status.state === "waiting") state.textContent = "Waiting for your phone… (" + (status.expires_in_s ?? 0) + "s left)";
      if (status.state === "pending_confirm") {
        row.classList.remove("hidden");
        document.getElementById("fp").textContent = status.fingerprint ?? "";
        state.textContent = (status.device_name ?? "A phone") + " wants to pair.";
      }
      if (status.state === "granted") { row.classList.add("hidden"); state.textContent = "✅ Paired! Your phone is connected — this closes itself."; }
      if (status.state === "expired") state.textContent = "Code expired — run “Relay: Pair phone” again.";
      if (status.state === "locked") state.textContent = "Too many wrong codes — run “Relay: Pair phone” again.";
      if (status.state === "cancelled") state.textContent = "Pairing cancelled.";
    });
  </script>
</body></html>`;
}

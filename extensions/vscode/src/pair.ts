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
    const pick = await vscode.window.showInformationMessage(
      "Relay needs to set up this computer first (one time). Pairing opens automatically after.",
      { modal: true },
      "Set up & pair",
    );
    if (pick) await vscode.commands.executeCommand("relay.setup");
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
  :root {
    --bg: #0a0d14; --surface: #131827; --ink: #e9edf4; --dim: #8f99ad;
    --line: #232a3d; --accent: #22d3ee; --accent-2: #a78bfa;
    --grad: linear-gradient(135deg, #a78bfa, #22d3ee);
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: var(--vscode-font-family, system-ui); background: var(--bg); color: var(--ink);
    min-height: 100vh; display: flex; justify-content: center; padding: 34px 20px 48px;
  }
  .wrap { width: 100%; max-width: 720px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .brand svg { display: block; }
  .brand b { font-size: 15px; letter-spacing: .4px; }
  .brand span { color: var(--dim); font-size: 12px; }
  h1 {
    font-size: 26px; margin: 14px 0 6px; letter-spacing: -.4px;
    background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent;
    width: fit-content;
  }
  .lede { color: var(--dim); font-size: 13px; margin-bottom: 24px; }
  .lede a { color: var(--accent); }
  .grid { display: grid; grid-template-columns: 1fr 300px; gap: 22px; align-items: start; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
  .steps { display: flex; flex-direction: column; gap: 14px; }
  .step { display: flex; gap: 12px; align-items: flex-start; }
  .step i {
    flex: none; width: 22px; height: 22px; border-radius: 50%; font-style: normal; font-size: 11px;
    font-weight: 700; display: grid; place-items: center; background: var(--grad); color: #0a0d14;
  }
  .step div b { font-size: 13px; display: block; margin-bottom: 2px; }
  .step div p { color: var(--dim); font-size: 12px; line-height: 1.5; }
  .step code { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; font-size: 11px; }
  .qr-card {
    background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 18px;
    display: flex; flex-direction: column; align-items: center; gap: 12px; position: relative;
  }
  .qr-card::before {
    content: ""; position: absolute; inset: -1px; border-radius: 18px; padding: 1px;
    background: var(--grad); -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude; opacity: .55; pointer-events: none;
  }
  img.qr { width: 100%; max-width: 250px; aspect-ratio: 1; border-radius: 12px; background: #fff; padding: 12px; }
  .code {
    font-size: 22px; letter-spacing: 6px; font-weight: 700;
    font-family: var(--vscode-editor-font-family, monospace); color: var(--accent);
  }
  .code-hint { color: var(--dim); font-size: 11px; margin-top: -8px; }
  .state { color: var(--dim); font-size: 13px; text-align: center; min-height: 20px; }
  .state.live::before {
    content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent); margin-right: 7px; animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse { 50% { opacity: .35; } }
  .confirm {
    margin-top: 22px; background: var(--surface); border: 1px solid var(--line); border-radius: 16px;
    padding: 20px 22px; display: flex; flex-direction: column; align-items: center; gap: 10px;
  }
  .confirm .kicker { font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: var(--accent-2); font-weight: 700; }
  .fp { font-size: 34px; letter-spacing: 8px; }
  .confirm p { color: var(--dim); font-size: 12.5px; text-align: center; }
  .actions { display: flex; gap: 10px; margin-top: 6px; }
  button {
    padding: 9px 22px; border: none; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 600;
    font-family: inherit;
  }
  .ok { background: var(--grad); color: #0a0d14; }
  .ok:hover { filter: brightness(1.12); }
  .no { background: transparent; color: var(--dim); border: 1px solid var(--line); }
  .no:hover { color: var(--ink); border-color: var(--dim); }
  .hidden { display: none; }
  .success { text-align: center; padding: 30px 0 6px; }
  .success .mark { font-size: 44px; display: block; margin-bottom: 10px; }
  .success b { font-size: 17px; }
  .success p { color: var(--dim); font-size: 13px; margin-top: 6px; }
  @media (prefers-reduced-motion: reduce) { .state.live::before { animation: none; } }
</style></head>
<body>
  <div class="wrap">
    <div class="brand">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <defs><linearGradient id="g" x1="4" y1="20" x2="20" y2="4"><stop stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
        <circle cx="7.5" cy="16.5" r="2.3" fill="url(#g)"/>
        <path d="M11.5 9.5a7.6 7.6 0 0 1 5 5M13 5a12.4 12.4 0 0 1 8 8" stroke="url(#g)" stroke-width="2.2" stroke-linecap="round"/>
      </svg>
      <b>Relay</b><span>by Bytical</span>
    </div>
    <div id="main">
      <h1>Pair your phone</h1>
      <p class="lede">One scan connects this computer to your phone — encrypted end to end. Same Wi-Fi needed for this step only.</p>
      <div class="grid">
        <div class="steps">
          <div class="step"><i>1</i><div><b>Get the app</b><p>On your Android phone, visit <code>relay.bytical.ai/download</code> — one tap installs it.</p></div></div>
          <div class="step"><i>2</i><div><b>Open Relay → Pair</b><p>Tap <code>Pair a machine</code> on the app's home screen.</p></div></div>
          <div class="step"><i>3</i><div><b>Scan this code</b><p>Point the camera at the QR — or type the letter code shown below it.</p></div></div>
        </div>
        <div class="qr-card">
          <img class="qr" alt="pairing QR" src="${qrDataUrl}">
          <div class="code">${code}</div>
          <div class="code-hint">manual entry code</div>
          <div class="state live" id="state">Waiting for your phone…</div>
        </div>
      </div>
      <div id="confirmRow" class="confirm hidden">
        <div class="kicker">Confirm it's your phone</div>
        <div class="fp" id="fp"></div>
        <p id="who">Check the same emoji show on the phone, then confirm.</p>
        <div class="actions">
          <button class="ok" id="yes">They match — pair</button>
          <button class="no" id="no">Cancel</button>
        </div>
      </div>
    </div>
    <div id="done" class="success hidden">
      <span class="mark">✅</span>
      <b>Paired! Your phone is connected.</b>
      <p>Start an agent from the phone, approve from your lock screen, and this laptop does the rest.<br/>This panel closes itself.</p>
    </div>
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
        document.getElementById("who").textContent = (status.device_name ?? "A phone") + " wants to pair — check the same emoji show there, then confirm.";
        state.textContent = "Phone found.";
      }
      if (status.state === "granted") {
        document.getElementById("main").classList.add("hidden");
        document.getElementById("done").classList.remove("hidden");
      }
      if (status.state === "expired") { state.classList.remove("live"); state.textContent = "Code expired — run “Relay: Pair phone” again."; }
      if (status.state === "locked") { state.classList.remove("live"); state.textContent = "Too many wrong codes — run “Relay: Pair phone” again."; }
      if (status.state === "cancelled") { state.classList.remove("live"); state.textContent = "Pairing cancelled."; }
    });
  </script>
</body></html>`;
}

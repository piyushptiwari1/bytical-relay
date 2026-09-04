// Live probe: pair a simulated phone through the REAL relay bridge —
// proves pairing works with zero LAN reachability (isolated Wi-Fi path).
// Usage: pnpm probe:pair-relay  (or: tsx tooling/probe-pair-relay.mjs)
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fromB64, generateKxKeypair } from "@rdc/security";
import { pairWithController } from "@rdc/transport";

const configDir = process.env.RDC_CONFIG_DIR ?? path.join(process.env.LOCALAPPDATA ?? "", "rdc");
const config = JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8"));
const base = `http://127.0.0.1:${config.port ?? 8347}`;
const headers = { authorization: `Bearer ${config.local_token}` };

const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  process.exit(1);
};

const started = await (
  await fetch(`${base}/api/pairing/start`, { method: "POST", headers })
).json();
const qr = started.qr_payload;
if (!qr?.relay_pair_url)
  fail("qr_payload.relay_pair_url missing — relay not configured or controller stale");
console.log(`PASS qr carries relay_pair_url (${qr.relay_pair_url.split("?")[0]})`);

// owner auto-confirm the moment the phone request lands
const confirmLoop = setInterval(async () => {
  try {
    const status = await (await fetch(`${base}/api/pairing/status`, { headers })).json();
    if (status.state === "pending_confirm") {
      clearInterval(confirmLoop);
      await fetch(`${base}/api/pairing/confirm`, { method: "POST", headers });
    }
  } catch {}
}, 400);

const keypair = generateKxKeypair();
let grant;
try {
  grant = await pairWithController({
    url: qr.relay_pair_url,
    code: qr.code,
    deviceName: "probe (relay pairing)",
    installId: "probe-relay-pairing-fixed-0001",
    keypair,
    controllerKxPub: fromB64(qr.kx_pub),
    timeoutMs: 30_000,
    connectTimeoutMs: 15_000,
  });
} catch (cause) {
  clearInterval(confirmLoop);
  fail(`pairing through relay bridge: ${cause?.message ?? cause}`);
}
clearInterval(confirmLoop);
if (grant.machine_id !== qr.machine_id) fail("grant machine mismatch");
console.log(`PASS paired through the internet relay — device ${grant.device_id}`);

// cleanup: revoke the probe device so it never lingers
const revoke = await fetch(`${base}/api/devices/${grant.device_id}/revoke`, {
  method: "POST",
  headers,
});
console.log(
  revoke.ok ? "PASS probe device revoked" : "WARN probe device revoke failed — revoke manually",
);
console.log("3/3 relay-pairing probe complete");
process.exit(0);

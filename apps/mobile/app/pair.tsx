import { PairQrSchema } from "@rdc/protocol";
import { fromB64, generateKxKeypair, toB64 } from "@rdc/security/client";
import { pairWithController } from "@rdc/transport";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { humanError } from "../src/errors.ts";
import { getInstallId } from "../src/install-id.ts";
import { useApp } from "../src/machines.ts";
import { Button, Card, colors, space, type_ } from "../src/theme.tsx";

/** "Samsung Galaxy S23" beats "Android (rdc)" in the device list. */
function deviceLabel(): string {
  const parts = [Device.manufacturer, Device.modelName].filter(Boolean) as string[];
  const label = parts.join(" ").trim();
  return label || (Platform.OS === "ios" ? "iPhone" : "Android device");
}

type Phase =
  | { step: "scan" }
  | { step: "connecting"; name: string }
  | { step: "confirm"; name: string; fingerprint: string }
  | { step: "error"; message: string; attempts?: Array<{ addr: string; reason: string }> };

export default function Pair() {
  const router = useRouter();
  const addMachine = useApp((s) => s.addMachine);
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ step: "scan" });
  const scanning = useRef(false);
  const lastQr = useRef<string | null>(null);

  async function handleScan(data: string) {
    if (scanning.current) return;
    scanning.current = true;
    lastQr.current = data;
    try {
      const qr = PairQrSchema.parse(JSON.parse(data));
      setPhase({ step: "connecting", name: qr.name });
      const keypair = generateKxKeypair();
      const installId = await getInstallId();
      const attempts: Array<{ addr: string; reason: string }> = [];
      for (const addr of qr.addrs) {
        try {
          const grant = await pairWithController({
            url: `${addr}/pair`,
            code: qr.code,
            deviceName: deviceLabel(),
            installId,
            keypair,
            controllerKxPub: fromB64(qr.kx_pub),
            timeoutMs: 90_000,
            onPending: (fingerprint) => setPhase({ step: "confirm", name: qr.name, fingerprint }),
          });
          await addMachine({
            machine_id: grant.machine_id,
            name: grant.machine_name,
            device_id: grant.device_id,
            token: grant.token,
            token_expires_at: grant.token_expires_at,
            controller_kx_pub: grant.controller_kx_pub,
            kx_pub: toB64(keypair.publicKey),
            kx_priv: toB64(keypair.privateKey),
            addrs: qr.addrs,
          });
          router.replace("/");
          return;
        } catch (cause) {
          const raw = cause instanceof Error ? cause.message : String(cause);
          attempts.push({
            addr: addr.replace(/^wss?:\/\//, ""),
            reason: /timeout|timed out/i.test(raw)
              ? "timed out — different network or the Wi-Fi isolates devices"
              : /refused|ECONNREFUSED/i.test(raw)
                ? "refused — a firewall on the computer may block the port"
                : humanError(cause),
          });
        }
      }
      setPhase({ step: "error", message: `Couldn't reach ${qr.name}`, attempts });
      scanning.current = false;
    } catch {
      setPhase({ step: "error", message: "That QR code is not a Relay pairing code." });
      scanning.current = false;
    }
  }

  if (!permission?.granted) {
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: space.xl, gap: space.lg }}>
        <Text style={{ fontSize: 34, textAlign: "center" }}>📷</Text>
        <Text style={{ ...type_.heading, textAlign: "center" }}>Camera access needed</Text>
        <Text style={{ ...type_.caption, textAlign: "center" }}>
          The camera is only used to scan the Relay pairing QR code shown on your computer.
        </Text>
        <Button label="Allow camera" onPress={() => void requestPermission()} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {phase.step === "scan" ? (
        <>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => void handleScan(data)}
          />
          <View style={{ padding: space.lg }}>
            <Text style={{ ...type_.caption, textAlign: "center" }}>
              Point at the QR code in the Relay dashboard → “Pair device”.
            </Text>
          </View>
        </>
      ) : (
        <View style={{ flex: 1, justifyContent: "center", padding: space.xl, gap: space.lg }}>
          {phase.step === "connecting" ? (
            <Text style={{ ...type_.heading, textAlign: "center" }}>
              Connecting to {phase.name}…
            </Text>
          ) : null}
          {phase.step === "confirm" ? (
            <Card style={{ alignItems: "center", gap: space.lg, paddingVertical: space.xxl }}>
              <Text style={type_.micro}>Verification code</Text>
              <Text style={{ fontSize: 44, letterSpacing: 6 }}>{phase.fingerprint}</Text>
              <Text style={{ ...type_.caption, textAlign: "center", maxWidth: 260 }}>
                Compare with {phase.name}. If the emoji match, press Confirm on your computer.
              </Text>
            </Card>
          ) : null}
          {phase.step === "error" ? (
            <>
              <Text style={{ ...type_.heading, color: colors.bad, textAlign: "center" }}>
                {phase.message}
              </Text>
              {phase.attempts?.length ? (
                <Card style={{ gap: 6 }}>
                  {phase.attempts.map((a) => (
                    <Text key={a.addr} style={type_.caption}>
                      · {a.addr} — {a.reason}
                    </Text>
                  ))}
                </Card>
              ) : null}
              {phase.attempts?.length ? (
                <Card style={{ gap: 6 }}>
                  <Text style={{ ...type_.caption, color: colors.text, fontWeight: "600" }}>
                    Pairing needs the phone and computer on the same network once:
                  </Text>
                  <Text style={type_.caption}>· Same Wi-Fi on both (phone not on mobile data)</Text>
                  <Text style={type_.caption}>· VPN off on both during pairing</Text>
                  <Text style={type_.caption}>
                    · Office/guest Wi-Fi often isolates devices — try your phone's hotspot: connect
                    the computer to it, then scan again
                  </Text>
                  <Text style={type_.caption}>
                    · If an address said “refused”: allow Relay/Node through the computer's firewall
                    for private networks
                  </Text>
                </Card>
              ) : null}
              {lastQr.current ? (
                <Button
                  label="Try again"
                  onPress={() => {
                    const qr = lastQr.current;
                    if (qr) void handleScan(qr);
                  }}
                />
              ) : null}
              <Button label="Scan again" kind="ghost" onPress={() => setPhase({ step: "scan" })} />
            </>
          ) : null}
        </View>
      )}
    </View>
  );
}

import { PairQrSchema } from "@rdc/protocol";
import { fromB64, generateKxKeypair, toB64 } from "@rdc/security/client";
import { pairWithController } from "@rdc/transport";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { useApp } from "../src/machines.ts";
import { Button, Card, colors, space, type_ } from "../src/theme.tsx";

type Phase =
  | { step: "scan" }
  | { step: "connecting"; name: string }
  | { step: "confirm"; name: string; fingerprint: string }
  | { step: "error"; message: string };

export default function Pair() {
  const router = useRouter();
  const addMachine = useApp((s) => s.addMachine);
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ step: "scan" });
  const scanning = useRef(false);

  async function handleScan(data: string) {
    if (scanning.current) return;
    scanning.current = true;
    try {
      const qr = PairQrSchema.parse(JSON.parse(data));
      setPhase({ step: "connecting", name: qr.name });
      const keypair = generateKxKeypair();
      let lastError = "no reachable address";
      for (const addr of qr.addrs) {
        try {
          const grant = await pairWithController({
            url: `${addr}/pair`,
            code: qr.code,
            deviceName: `${Platform.OS === "ios" ? "iPhone" : "Android"} (rdc)`,
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
            controller_kx_pub: grant.controller_kx_pub,
            kx_pub: toB64(keypair.publicKey),
            kx_priv: toB64(keypair.privateKey),
            addrs: qr.addrs,
          });
          router.replace("/");
          return;
        } catch (cause) {
          lastError = cause instanceof Error ? cause.message : String(cause);
        }
      }
      setPhase({ step: "error", message: lastError });
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
              <Text style={{ ...type_.body, color: colors.bad, textAlign: "center" }}>
                {phase.message}
              </Text>
              <Button label="Scan again" kind="ghost" onPress={() => setPhase({ step: "scan" })} />
            </>
          ) : null}
        </View>
      )}
    </View>
  );
}

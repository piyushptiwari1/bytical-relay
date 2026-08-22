import { PairQrSchema } from "@rdc/protocol";
import { fromB64, generateKxKeypair, toB64 } from "@rdc/security/client";
import { pairWithController } from "@rdc/transport";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useApp } from "../src/machines.ts";
import { colors } from "../src/theme.ts";

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
      setPhase({ step: "error", message: "that QR is not an rdc pairing code" });
      scanning.current = false;
    }
  }

  if (!permission?.granted) {
    return (
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 }}
      >
        <Text style={{ color: colors.text, textAlign: "center" }}>
          Camera access is needed to scan the pairing QR code.
        </Text>
        <Pressable
          onPress={() => void requestPermission()}
          style={{
            backgroundColor: colors.accent,
            borderRadius: 8,
            paddingHorizontal: 24,
            paddingVertical: 12,
          }}
        >
          <Text style={{ color: colors.bg, fontWeight: "600" }}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {phase.step === "scan" ? (
        <CameraView
          style={{ flex: 1 }}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => void handleScan(data)}
        />
      ) : (
        <View
          style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 }}
        >
          {phase.step === "connecting" ? (
            <Text style={{ color: colors.text }}>Connecting to {phase.name}…</Text>
          ) : null}
          {phase.step === "confirm" ? (
            <>
              <Text style={{ color: colors.text, fontSize: 16 }}>Compare with {phase.name}:</Text>
              <Text style={{ fontSize: 42 }}>{phase.fingerprint}</Text>
              <Text style={{ color: colors.dim, textAlign: "center" }}>
                If the emoji match, press Confirm on your computer.
              </Text>
            </>
          ) : null}
          {phase.step === "error" ? (
            <>
              <Text style={{ color: colors.bad, textAlign: "center" }}>{phase.message}</Text>
              <Pressable
                onPress={() => setPhase({ step: "scan" })}
                style={{
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  paddingHorizontal: 24,
                  paddingVertical: 12,
                }}
              >
                <Text style={{ color: colors.text }}>Scan again</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      )}
    </View>
  );
}

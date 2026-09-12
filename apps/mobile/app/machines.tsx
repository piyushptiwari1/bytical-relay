import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useApp } from "../src/machines.ts";
import { Card, colors, Pill, type PillTone, StatusDot, space, type_ } from "../src/theme.tsx";
import { checkForUpdateNow } from "../src/update-check.ts";

const connectionStyle: Record<string, { color: string; tone: PillTone; label: string }> = {
  ready: { color: colors.ok, tone: "ok", label: "connected" },
  connecting: { color: colors.warn, tone: "warn", label: "connecting" },
  reconnecting: { color: colors.warn, tone: "warn", label: "reconnecting" },
  unreachable: { color: colors.bad, tone: "bad", label: "unreachable" },
  closed: { color: colors.faint, tone: "dim", label: "offline" },
  idle: { color: colors.faint, tone: "dim", label: "waiting" },
};
const waitingConnection = { color: colors.faint, tone: "dim" as const, label: "waiting" };

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Infrastructure lives here, off the chat path: computers, pairing, app updates. */
export default function Machines() {
  const router = useRouter();
  const machines = useApp((s) => s.machines);
  const runtime = useApp((s) => s.runtime);
  const connect = useApp((s) => s.connect);
  const refreshMachine = useApp((s) => s.refreshMachine);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const retry = (machineId: string) => {
    void refreshMachine(machineId).catch(() => connect(machineId));
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl }}
    >
      <View style={{ borderTopColor: colors.borderSoft, borderTopWidth: 1 }}>
        {machines.map((machine) => {
          const machineRuntime = runtime[machine.machine_id];
          const state = connectionStyle[machineRuntime?.state ?? "idle"] ?? waitingConnection;
          const transport =
            machineRuntime?.transport === "relay"
              ? "Relay"
              : machineRuntime?.transport === "direct"
                ? "LAN"
                : null;
          const sampledAt = machineRuntime?.health?.sampled_at ?? machineRuntime?.last_refreshed_at;
          return (
            <Pressable
              key={machine.machine_id}
              onPress={() => router.push(`/machine/${machine.machine_id}`)}
              style={({ pressed }) => ({
                alignItems: "center",
                borderBottomColor: colors.borderSoft,
                borderBottomWidth: 1,
                flexDirection: "row",
                gap: space.sm,
                opacity: pressed ? 0.72 : 1,
                paddingVertical: space.md,
              })}
            >
              <StatusDot color={state.color} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ ...type_.body, fontWeight: "600" }} numberOfLines={1}>
                  {machine.name}
                </Text>
                <Text style={type_.caption} numberOfLines={1}>
                  {[transport, sampledAt ? `updated ${relativeTime(sampledAt)}` : "waiting"]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              {machineRuntime?.state === "unreachable" ? (
                <Pressable
                  accessibilityLabel={`Retry ${machine.name}`}
                  onPress={(event) => {
                    event.stopPropagation();
                    retry(machine.machine_id);
                  }}
                  style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, padding: space.xs })}
                >
                  <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
                    Retry
                  </Text>
                </Pressable>
              ) : (
                <Pill tone={state.tone}>{state.label}</Pill>
              )}
            </Pressable>
          );
        })}
      </View>

      <Card
        onPress={() => router.push("/pair")}
        style={{ alignItems: "center", paddingVertical: space.md }}
      >
        <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
          Pair another computer
        </Text>
      </Card>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.push("/feedback")}
        style={{ alignItems: "center", paddingVertical: space.sm }}
      >
        <Text style={{ ...type_.caption, textDecorationLine: "underline" }}>
          Review · request · report — send feedback
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        disabled={checkingUpdate}
        onPress={() => {
          setCheckingUpdate(true);
          void checkForUpdateNow()
            .then((result) => {
              if (result.status === "update") {
                Alert.alert(
                  `Relay ${result.update.version} is available`,
                  "Download installs over this version — your pairings are kept.",
                  [
                    { text: "Later", style: "cancel" },
                    { text: "Download", onPress: () => void Linking.openURL(result.update.url) },
                  ],
                );
              } else if (result.status === "latest") {
                Alert.alert("You're up to date", `Relay ${result.current} is the newest version.`);
              } else {
                Alert.alert(
                  "Couldn't check",
                  "No connection to the releases feed right now — try again later.",
                );
              }
            })
            .finally(() => setCheckingUpdate(false));
        }}
        style={{ alignItems: "center", paddingVertical: space.sm }}
      >
        <Text style={{ ...type_.caption, textDecorationLine: "underline" }}>
          {checkingUpdate
            ? "checking…"
            : `Relay ${Constants.expoConfig?.version ?? ""} — check for updates`}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

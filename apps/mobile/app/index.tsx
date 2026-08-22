import { Link, useRouter } from "expo-router";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useApp } from "../src/machines.ts";
import { colors, formatGb } from "../src/theme.ts";

const stateColor: Record<string, string> = {
  ready: colors.ok,
  connecting: colors.warn,
  reconnecting: colors.warn,
  unreachable: colors.bad,
  closed: colors.dim,
  idle: colors.dim,
};

export default function Machines() {
  const router = useRouter();
  const machines = useApp((s) => s.machines);
  const runtime = useApp((s) => s.runtime);
  const toggleAwake = useApp((s) => s.toggleAwake);

  if (machines.length === 0) {
    return (
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 }}
      >
        <Text style={{ color: colors.text, fontSize: 18 }}>No machines paired yet</Text>
        <Text style={{ color: colors.dim, textAlign: "center" }}>
          Open the controller dashboard on your computer, press “Pair device”, then scan the QR
          code.
        </Text>
        <Link href="/pair" asChild>
          <Pressable
            style={{
              backgroundColor: colors.accent,
              borderRadius: 8,
              paddingHorizontal: 24,
              paddingVertical: 12,
            }}
          >
            <Text style={{ color: colors.bg, fontWeight: "600" }}>Scan pairing QR</Text>
          </Pressable>
        </Link>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 12 }}>
      {machines.map((machine) => {
        const rt = runtime[machine.machine_id];
        const health = rt?.health;
        return (
          <Pressable
            key={machine.machine_id}
            onPress={() => router.push(`/machine/${machine.machine_id}`)}
            style={{
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: 10,
              padding: 14,
              gap: 6,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  backgroundColor: stateColor[rt?.state ?? "idle"] ?? colors.dim,
                }}
              />
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>
                {machine.name}
              </Text>
              <Text style={{ color: colors.dim, fontSize: 12 }}>{rt?.state ?? "idle"}</Text>
            </View>
            {health ? (
              <Text style={{ color: colors.dim, fontSize: 12 }}>
                RAM {formatGb(health.memory.total_bytes - health.memory.free_bytes)}/
                {formatGb(health.memory.total_bytes)}
                {health.cpu.load_percent !== null ? ` · CPU ${health.cpu.load_percent}%` : ""}
                {health.network.online ? ` · net ${health.network.latency_ms}ms` : " · offline"}
                {health.battery ? ` · 🔋${health.battery.percent}%` : ""}
              </Text>
            ) : null}
            <Text style={{ color: colors.dim, fontSize: 12 }}>
              {rt?.projects?.length ?? 0} project(s)
            </Text>
            {health?.keep_awake.supported ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text
                  style={{
                    color: health.keep_awake.enabled ? colors.ok : colors.dim,
                    fontSize: 13,
                  }}
                >
                  ☕ keep awake
                </Text>
                <Switch
                  value={health.keep_awake.enabled}
                  onValueChange={() => void toggleAwake(machine.machine_id)}
                />
              </View>
            ) : null}
          </Pressable>
        );
      })}
      <Link href="/pair" asChild>
        <Pressable style={{ alignItems: "center", padding: 12 }}>
          <Text style={{ color: colors.accent }}>+ Pair another machine</Text>
        </Pressable>
      </Link>
    </ScrollView>
  );
}

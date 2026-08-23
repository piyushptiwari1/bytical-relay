import { useRouter } from "expo-router";
import { ScrollView, Switch, Text, View } from "react-native";
import { useApp } from "../src/machines.ts";
import {
  Button,
  Card,
  colors,
  EmptyState,
  formatGb,
  Pill,
  type PillTone,
  StatusDot,
  space,
  type_,
} from "../src/theme.tsx";

const stateStyle: Record<string, { color: string; tone: PillTone; label: string }> = {
  ready: { color: colors.ok, tone: "ok", label: "online" },
  connecting: { color: colors.warn, tone: "warn", label: "connecting" },
  reconnecting: { color: colors.warn, tone: "warn", label: "reconnecting" },
  unreachable: { color: colors.bad, tone: "bad", label: "unreachable" },
  closed: { color: colors.faint, tone: "dim", label: "offline" },
  idle: { color: colors.faint, tone: "dim", label: "idle" },
};

export default function Machines() {
  const router = useRouter();
  const machines = useApp((s) => s.machines);
  const runtime = useApp((s) => s.runtime);
  const toggleAwake = useApp((s) => s.toggleAwake);

  if (machines.length === 0) {
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: space.xl, gap: space.lg }}>
        <EmptyState
          icon="⌘"
          title="No machines yet"
          caption="Open the rdc dashboard on your computer, press “Pair device”, then scan the QR code here."
        />
        <Button label="Scan pairing QR" onPress={() => router.push("/pair")} />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl }}
    >
      {machines.map((machine) => {
        const rt = runtime[machine.machine_id];
        const health = rt?.health;
        const st = stateStyle[rt?.state ?? "idle"] ?? stateStyle.idle;
        const editing = rt?.editors?.find((e) => e.active_file)?.active_file;
        const usedRam = health ? health.memory.total_bytes - health.memory.free_bytes : 0;
        return (
          <Card
            key={machine.machine_id}
            onPress={() => router.push(`/machine/${machine.machine_id}`)}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <StatusDot color={st?.color ?? colors.faint} />
              <Text style={{ ...type_.heading, flex: 1 }} numberOfLines={1}>
                {machine.name}
              </Text>
              <Pill tone={st?.tone ?? "dim"}>{st?.label ?? "idle"}</Pill>
            </View>

            {health ? (
              <View style={{ flexDirection: "row", gap: space.lg, marginTop: 2 }}>
                <Metric
                  label="CPU"
                  value={health.cpu.load_percent !== null ? `${health.cpu.load_percent}%` : "—"}
                />
                <Metric
                  label="RAM"
                  value={`${formatGb(usedRam)} / ${formatGb(health.memory.total_bytes)}`}
                />
                <Metric label="NET" value={health.network.online ? "online" : "offline"} />
              </View>
            ) : (
              <Text style={type_.caption}>waiting for telemetry…</Text>
            )}

            {editing ? (
              <Text style={{ ...type_.caption, color: colors.accent }} numberOfLines={1}>
                ✎ editing {editing.name}
                {editing.line ? `:${editing.line}` : ""}
              </Text>
            ) : null}

            {health?.keep_awake.supported ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: space.xs,
                  borderTopWidth: 1,
                  borderTopColor: colors.borderSoft,
                  paddingTop: space.sm,
                }}
              >
                <Text style={type_.caption}>Keep machine awake</Text>
                <Switch
                  value={health.keep_awake.enabled}
                  onValueChange={() => void toggleAwake(machine.machine_id)}
                  trackColor={{ false: colors.border, true: colors.accentSoft }}
                  thumbColor={health.keep_awake.enabled ? colors.accent : colors.dim}
                />
              </View>
            ) : null}
          </Card>
        );
      })}

      <Button label="+ Pair another machine" kind="ghost" onPress={() => router.push("/pair")} />
    </ScrollView>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <View style={{ gap: 1 }}>
      <Text style={type_.micro}>{props.label}</Text>
      <Text style={{ ...type_.body, fontSize: 13 }}>{props.value}</Text>
    </View>
  );
}

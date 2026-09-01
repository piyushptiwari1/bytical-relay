import type { AgentSession } from "@rdc/protocol";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useApp } from "../src/machines.ts";
import {
  Button,
  Card,
  colors,
  EmptyState,
  Pill,
  type PillTone,
  SectionLabel,
  StatusDot,
  space,
  type_,
} from "../src/theme.tsx";
import { type AvailableUpdate, checkForUpdate } from "../src/update-check.ts";

type SessionItem = {
  machineId: string;
  machineName: string;
  projectName: string;
  waitingToSend: number;
  session: AgentSession;
};

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

function sessionLabel(session: AgentSession): string {
  if (session.status === "awaiting_approval") return "Approval needed";
  if (session.status === "failed") return "Needs review";
  if (session.status === "starting") return "Starting";
  if (session.status === "running") return "Working";
  if (session.status === "idle") return "Ready";
  if (session.status === "completed") return "Completed";
  return "Stopped";
}

function sessionTone(session: AgentSession): PillTone {
  if (session.status === "awaiting_approval" || session.status === "failed") return "bad";
  if (session.status === "starting" || session.status === "running") return "warn";
  if (session.status === "idle" || session.status === "completed") return "ok";
  return "dim";
}

export default function RelayHome() {
  const router = useRouter();
  const machines = useApp((s) => s.machines);
  const runtime = useApp((s) => s.runtime);
  const connect = useApp((s) => s.connect);
  const refreshMachine = useApp((s) => s.refreshMachine);
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);

  useEffect(() => {
    void checkForUpdate().then(setUpdate);
  }, []);

  const updateBanner = update ? (
    <Pressable
      accessibilityRole="button"
      onPress={() => void Linking.openURL(update.url)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        borderLeftWidth: 2,
        borderLeftColor: colors.ok,
        paddingLeft: space.md,
        paddingVertical: space.xs,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ ...type_.body, fontSize: 13 }}>
          Relay {update.version} is available — tap to download.
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss update notice"
        hitSlop={8}
        onPress={() => setUpdate(null)}
      >
        <Text style={{ ...type_.caption, fontSize: 13 }}>✕</Text>
      </Pressable>
    </Pressable>
  ) : null;

  if (machines.length === 0) {
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: space.xl, gap: space.lg }}>
        {updateBanner}
        <EmptyState
          icon=""
          title="Connect your computer"
          caption="On your computer, open the Relay dashboard and choose Pair device. Then scan its QR code here."
        />
        <Button label="Scan pairing QR" onPress={() => router.push("/pair")} />
      </View>
    );
  }

  const sessionItems: SessionItem[] = machines.flatMap((machine) => {
    const machineRuntime = runtime[machine.machine_id];
    return (machineRuntime?.sessions ?? []).map((session) => ({
      machineId: machine.machine_id,
      machineName: machine.name,
      projectName:
        machineRuntime?.projects?.find((project) => project.project_id === session.project_id)
          ?.name ?? "Workspace",
      waitingToSend: machineRuntime?.pending_prompt_counts?.[session.session_id] ?? 0,
      session,
    }));
  });
  const byRecent = (left: SessionItem, right: SessionItem) =>
    right.session.updated_at.localeCompare(left.session.updated_at);
  const attention = sessionItems
    .filter(
      (item) => item.session.status === "awaiting_approval" || item.session.status === "failed",
    )
    .sort(byRecent);
  const active = sessionItems
    .filter((item) => item.session.status === "starting" || item.session.status === "running")
    .sort(byRecent);
  const recentlyReady = sessionItems
    .filter((item) => item.session.status === "idle" || item.session.status === "completed")
    .sort(byRecent)
    .slice(0, 3);

  const retry = (machineId: string) => {
    void refreshMachine(machineId).catch(() => connect(machineId));
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl }}
    >
      <View style={{ gap: 4, paddingTop: space.xs }}>
        <Text style={type_.title}>Your work</Text>
        <Text style={type_.caption}>
          Follow what needs you now. Your computer keeps the work and its context.
        </Text>
      </View>

      {updateBanner}

      <SectionLabel>Needs your attention</SectionLabel>
      {attention.length > 0 ? (
        attention.map((item) => <WorkRow key={item.session.session_id} item={item} />)
      ) : (
        <View style={{ borderLeftWidth: 2, borderLeftColor: colors.ok, paddingLeft: space.md }}>
          <Text style={{ ...type_.body, fontSize: 13 }}>
            Nothing needs your decision right now.
          </Text>
        </View>
      )}

      <SectionLabel>Working now</SectionLabel>
      {active.length > 0 ? (
        active.map((item) => <WorkRow key={item.session.session_id} item={item} />)
      ) : (
        <Text style={type_.caption}>
          No active sessions. Start work from a workspace when you are ready.
        </Text>
      )}

      {recentlyReady.length > 0 ? (
        <>
          <SectionLabel>Ready to continue</SectionLabel>
          {recentlyReady.map((item) => (
            <WorkRow key={item.session.session_id} item={item} quiet />
          ))}
        </>
      ) : null}

      <SectionLabel>Computers</SectionLabel>
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
          const cpu = machineRuntime?.health?.cpu.load_percent;
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
                  {[
                    transport,
                    sampledAt ? `updated ${relativeTime(sampledAt)}` : "waiting for update",
                    cpu !== null && cpu !== undefined ? `CPU ${cpu}%` : null,
                  ]
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
    </ScrollView>
  );
}

function WorkRow(props: { item: SessionItem; quiet?: boolean }) {
  const router = useRouter();
  const { item, quiet = false } = props;
  const queuedPromptCount = item.session.queued_prompt_count ?? 0;
  return (
    <Pressable
      accessibilityLabel={`${sessionLabel(item.session)}: ${item.session.title}`}
      onPress={() => router.push(`/agent/${item.machineId}/${item.session.session_id}`)}
      style={({ pressed }) => ({
        backgroundColor: quiet ? "transparent" : colors.card,
        borderBottomColor: colors.borderSoft,
        borderColor: quiet ? "transparent" : colors.borderSoft,
        borderTopWidth: quiet ? 0 : 1,
        borderWidth: quiet ? 0 : 1,
        gap: space.sm,
        opacity: pressed ? 0.75 : 1,
        paddingHorizontal: quiet ? 0 : space.md,
        paddingVertical: space.md,
      })}
    >
      <View style={{ alignItems: "center", flexDirection: "row", gap: space.sm }}>
        <StatusDot
          color={
            item.session.status === "awaiting_approval" || item.session.status === "failed"
              ? colors.bad
              : item.session.status === "running" || item.session.status === "starting"
                ? colors.warn
                : colors.ok
          }
        />
        <Text style={{ ...type_.body, flex: 1, fontWeight: "600" }} numberOfLines={1}>
          {item.session.title}
        </Text>
        <Pill tone={sessionTone(item.session)}>{sessionLabel(item.session)}</Pill>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingLeft: 16 }}>
        <Text style={type_.caption} numberOfLines={1}>
          {item.projectName} · {item.machineName} · {relativeTime(item.session.updated_at)}
        </Text>
        {queuedPromptCount > 0 ? <Pill tone="accent">{queuedPromptCount} queued</Pill> : null}
        {item.waitingToSend > 0 ? (
          <Pill tone="warn">{item.waitingToSend} waiting to send</Pill>
        ) : null}
      </View>
    </Pressable>
  );
}

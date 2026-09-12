import type { AgentSession } from "@rdc/protocol";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useApp } from "../src/machines.ts";
import {
  Button,
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

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function sessionLabel(session: AgentSession): string {
  if (session.status === "awaiting_approval") return "needs you";
  if (session.status === "failed") return "needs you";
  if (session.status === "starting" || session.status === "running") return "working";
  return "done";
}

function sessionTone(session: AgentSession): PillTone {
  if (session.status === "awaiting_approval" || session.status === "failed") return "bad";
  if (session.status === "starting" || session.status === "running") return "warn";
  return "dim";
}

/** Conversations-first home: your chats plus one big input — machines stay backstage. */
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
          caption="Install the Relay extension in VS Code on your computer, choose Pair phone, then scan its QR code here."
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
  const chats = sessionItems
    .filter(
      (item) => item.session.status !== "awaiting_approval" && item.session.status !== "failed",
    )
    .sort(byRecent)
    .slice(0, 30);
  const troubled = machines.filter((machine) => {
    const state = runtime[machine.machine_id]?.state;
    return state === "unreachable" || state === "closed";
  });

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xl }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ ...type_.title, flex: 1 }}>Your chats</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push("/machines")}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, padding: space.xs })}
          >
            <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
              Computers ›
            </Text>
          </Pressable>
        </View>

        {updateBanner}

        {troubled.map((machine) => (
          <Pressable
            key={machine.machine_id}
            onPress={() =>
              void refreshMachine(machine.machine_id).catch(() => connect(machine.machine_id))
            }
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              borderLeftWidth: 2,
              borderLeftColor: colors.warn,
              paddingLeft: space.md,
              paddingVertical: space.xs,
            }}
          >
            <Text style={{ ...type_.caption, flex: 1 }}>
              {machine.name} is unreachable — is it on and online?
            </Text>
            <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>Retry</Text>
          </Pressable>
        ))}

        {attention.length > 0 ? (
          <>
            <SectionLabel>Needs you · {attention.length}</SectionLabel>
            {attention.map((item) => (
              <WorkRow key={item.session.session_id} item={item} />
            ))}
          </>
        ) : null}

        <SectionLabel>Chats</SectionLabel>
        {chats.map((item) => (
          <WorkRow key={item.session.session_id} item={item} quiet />
        ))}
        {chats.length === 0 && attention.length === 0 ? (
          <EmptyState
            icon="✦"
            title="Start your first chat"
            caption="Your agent runs on your computer and keeps working even when you put the phone away."
          />
        ) : null}
      </ScrollView>

      {/* the ChatGPT bar: one obvious way in, context remembered */}
      <View
        style={{
          paddingHorizontal: space.lg,
          paddingTop: space.sm,
          paddingBottom: space.lg,
          borderTopWidth: 1,
          borderTopColor: colors.borderSoft,
          backgroundColor: colors.bg,
        }}
      >
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/compose")}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            backgroundColor: pressed ? colors.cardRaised : colors.card,
            borderColor: colors.accent,
            borderWidth: 1,
            borderRadius: 26,
            paddingHorizontal: space.lg,
            paddingVertical: 14,
          })}
        >
          <Text style={{ color: colors.accent, fontSize: 18, fontWeight: "700" }}>＋</Text>
          <Text style={{ color: colors.dim, fontSize: 15, flex: 1 }}>Ask your agents…</Text>
        </Pressable>
      </View>
    </View>
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
        borderRadius: quiet ? 0 : 12,
        gap: space.sm,
        opacity: pressed ? 0.75 : 1,
        paddingHorizontal: quiet ? 0 : space.md,
        paddingVertical: space.md,
        borderBottomWidth: 1,
      })}
    >
      <View style={{ alignItems: "center", flexDirection: "row", gap: space.sm }}>
        <StatusDot
          color={
            item.session.status === "awaiting_approval" || item.session.status === "failed"
              ? colors.bad
              : item.session.status === "running" || item.session.status === "starting"
                ? colors.warn
                : colors.faint
          }
        />
        <Text style={{ ...type_.body, flex: 1, fontWeight: "600" }} numberOfLines={1}>
          {item.session.title}
        </Text>
        {sessionLabel(item.session) !== "done" ? (
          <Pill tone={sessionTone(item.session)}>{sessionLabel(item.session)}</Pill>
        ) : null}
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

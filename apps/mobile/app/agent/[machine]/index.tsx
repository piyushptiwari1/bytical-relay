import type { AgentSession } from "@rdc/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { agentList, agentStart, useApp, watchAgentStatus } from "../../../src/machines.ts";
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
} from "../../../src/theme.tsx";

const statusTone: Record<string, PillTone> = {
  starting: "warn",
  running: "warn",
  awaiting_approval: "bad",
  idle: "ok",
  completed: "ok",
  failed: "bad",
  cancelled: "dim",
};

export default function AgentsHome() {
  const { machine } = useLocalSearchParams<{ machine: string }>();
  const router = useRouter();
  const projects = useApp((s) => (machine ? (s.runtime[machine]?.projects ?? []) : []));
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [providers, setProviders] = useState<
    Array<{ id: string; available: boolean; detail: string }>
  >([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!machine) return;
    try {
      const result = await agentList(machine);
      setSessions(result.sessions);
      setProviders(result.providers);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [machine]);

  useEffect(() => {
    void load();
    if (!machine) return;
    return watchAgentStatus(machine, (session) => {
      setSessions((prev) => [session, ...prev.filter((s) => s.session_id !== session.session_id)]);
    });
  }, [machine, load]);

  if (!machine) return null;
  const copilot = providers.find((p) => p.id === "copilot");
  const chosenProject = projectId ?? projects[0]?.project_id ?? null;

  const start = async () => {
    if (!chosenProject || prompt.trim().length === 0) return;
    setBusy(true);
    try {
      const { session } = await agentStart(machine, chosenProject, "copilot", prompt.trim());
      setPrompt("");
      router.push(`/agent/${machine}/${session.session_id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
    >
      <Card style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <StatusDot color={copilot?.available ? colors.ok : colors.bad} />
          <Text style={{ ...type_.heading, flex: 1 }}>GitHub Copilot</Text>
          <Pill tone={copilot?.available ? "ok" : "bad"}>
            {copilot?.available ? "ready" : (copilot?.detail ?? "checking…")}
          </Pill>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.sm }}
        >
          {projects.map((project) => {
            const active = project.project_id === chosenProject;
            return (
              <Pressable
                key={project.project_id}
                onPress={() => setProjectId(project.project_id)}
                style={{
                  backgroundColor: active ? colors.accentSoft : "transparent",
                  borderColor: active ? colors.accent : colors.border,
                  borderWidth: 1,
                  borderRadius: 999,
                  paddingHorizontal: 14,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ color: active ? colors.accent : colors.dim, fontSize: 13 }}>
                  {project.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should Copilot do?"
          placeholderTextColor={colors.faint}
          multiline
          style={{
            backgroundColor: colors.bg,
            borderColor: colors.borderSoft,
            borderWidth: 1,
            borderRadius: 12,
            color: colors.text,
            padding: space.md,
            minHeight: 64,
            fontSize: 14,
          }}
        />
        <Button
          disabled={busy || !copilot?.available || prompt.trim().length === 0 || !chosenProject}
          label={busy ? "starting…" : "Start session"}
          onPress={() => void start()}
        />
        {error ? <Text style={{ ...type_.caption, color: colors.bad }}>{error}</Text> : null}
      </Card>

      <SectionLabel>Sessions</SectionLabel>
      {sessions.map((session) => (
        <Card
          key={session.session_id}
          onPress={() => router.push(`/agent/${machine}/${session.session_id}`)}
          style={{ marginBottom: space.sm, gap: space.xs }}
        >
          <Text style={type_.body} numberOfLines={1}>
            {session.title}
          </Text>
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
            <Pill tone={statusTone[session.status] ?? "dim"}>
              {session.status.replaceAll("_", " ")}
            </Pill>
            <Text style={type_.caption}>{session.provider}</Text>
          </View>
        </Card>
      ))}
      {sessions.length === 0 ? (
        <EmptyState
          icon="✦"
          title="No sessions yet"
          caption="Sessions run on your computer and keep working even when this phone disconnects."
        />
      ) : null}
    </ScrollView>
  );
}

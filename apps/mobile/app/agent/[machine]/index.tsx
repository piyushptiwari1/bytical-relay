import type { AgentSession } from "@rdc/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput } from "react-native";
import { agentList, agentStart, useApp, watchAgentStatus } from "../../../src/machines.ts";
import { colors } from "../../../src/theme.ts";

const statusColor: Record<string, string> = {
  starting: colors.warn,
  running: colors.warn,
  awaiting_approval: colors.bad,
  idle: colors.ok,
  completed: colors.ok,
  failed: colors.bad,
  cancelled: colors.dim,
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
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 12 }}>
      {providers.map((p) => (
        <Text key={p.id} style={{ color: p.available ? colors.ok : colors.bad, fontSize: 12 }}>
          {p.available ? "●" : "○"} {p.id} {p.detail ? `· ${p.detail}` : ""}
        </Text>
      ))}
      {error ? <Text style={{ color: colors.bad }}>{error}</Text> : null}

      <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>New session</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
      >
        {projects.map((project) => (
          <Pressable
            key={project.project_id}
            onPress={() => setProjectId(project.project_id)}
            style={{
              borderColor: project.project_id === chosenProject ? colors.accent : colors.border,
              borderWidth: 1,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 6,
            }}
          >
            <Text
              style={{
                color: project.project_id === chosenProject ? colors.accent : colors.dim,
                fontSize: 13,
              }}
            >
              {project.name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        placeholder="What should Copilot do?"
        placeholderTextColor={colors.dim}
        multiline
        style={{
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 8,
          color: colors.text,
          padding: 10,
          minHeight: 60,
        }}
      />
      <Pressable
        disabled={busy || !copilot?.available || prompt.trim().length === 0 || !chosenProject}
        onPress={() => void start()}
        style={{
          backgroundColor: prompt.trim() && copilot?.available ? colors.accent : colors.card,
          borderRadius: 8,
          alignItems: "center",
          paddingVertical: 12,
        }}
      >
        <Text
          style={{
            color: prompt.trim() && copilot?.available ? colors.bg : colors.dim,
            fontWeight: "600",
          }}
        >
          {busy ? "starting…" : "Start Copilot session"}
        </Text>
      </Pressable>

      <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>Sessions</Text>
      {sessions.map((session) => (
        <Pressable
          key={session.session_id}
          onPress={() => router.push(`/agent/${machine}/${session.session_id}`)}
          style={{
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 10,
            padding: 12,
            gap: 4,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 14 }} numberOfLines={1}>
            {session.title}
          </Text>
          <Text style={{ color: statusColor[session.status] ?? colors.dim, fontSize: 12 }}>
            {session.status} · {session.provider}
          </Text>
        </Pressable>
      ))}
      {sessions.length === 0 ? (
        <Text style={{ color: colors.dim }}>No sessions yet on this machine.</Text>
      ) : null}
    </ScrollView>
  );
}

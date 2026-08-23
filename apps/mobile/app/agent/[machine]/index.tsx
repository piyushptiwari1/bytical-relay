import type { AgentSession } from "@rdc/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  agentList,
  agentResume,
  agentStart,
  type ExternalSession,
  useApp,
  watchAgentStatus,
} from "../../../src/machines.ts";
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
const LIVE = new Set(["starting", "running", "awaiting_approval", "idle"]);

function relativeTime(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function AgentsHome() {
  const { machine } = useLocalSearchParams<{ machine: string }>();
  const router = useRouter();
  const projects = useApp((s) => (machine ? (s.runtime[machine]?.projects ?? []) : []));
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [external, setExternal] = useState<ExternalSession[]>([]);
  const [resuming, setResuming] = useState<string | null>(null);
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
      setExternal(result.external);
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
  const chosenProject = projects.find((p) => p.project_id === (projectId ?? "")) ?? projects[0];
  const ongoing = sessions.filter((s) => LIVE.has(s.status));
  const history = sessions.filter((s) => !LIVE.has(s.status));
  const projectName = (id: string) =>
    projects.find((p) => p.project_id === id)?.name ?? id.slice(0, 12);

  const start = async () => {
    if (!chosenProject || prompt.trim().length === 0) return;
    setBusy(true);
    try {
      const { session } = await agentStart(
        machine,
        chosenProject.project_id,
        "copilot",
        prompt.trim(),
      );
      setPrompt("");
      router.push(`/agent/${machine}/${session.session_id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const resume = async (item: ExternalSession) => {
    setResuming(item.native_id);
    try {
      const { session } = await agentResume(machine, item.provider, item.native_id);
      router.push(`/agent/${machine}/${session.session_id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setResuming(null);
    }
  };

  const sessionCard = (session: AgentSession, live: boolean) => (
    <Card
      key={session.session_id}
      onPress={() => router.push(`/agent/${machine}/${session.session_id}`)}
      accent={session.status === "awaiting_approval"}
      style={{ marginBottom: space.sm, gap: 6 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {live ? (
          <StatusDot color={session.status === "awaiting_approval" ? colors.bad : colors.warn} />
        ) : null}
        <Text style={{ ...type_.body, flex: 1, fontWeight: "600" }} numberOfLines={1}>
          {session.title}
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
        <Pill tone={statusTone[session.status] ?? "dim"}>
          {session.status === "awaiting_approval"
            ? "needs approval"
            : session.status.replaceAll("_", " ")}
        </Pill>
        <Text style={type_.caption}>
          {projectName(session.project_id)} · {relativeTime(session.updated_at)}
        </Text>
      </View>
    </Card>
  );

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
    >
      {/* composer — "New session in <project> with Copilot" */}
      <Card style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Text style={type_.caption}>New session in</Text>
          <Text style={{ ...type_.caption, color: colors.text, fontWeight: "600" }}>
            📁 {chosenProject?.name ?? "—"}
          </Text>
          <Text style={type_.caption}>with</Text>
          <Text style={{ ...type_.caption, color: colors.text, fontWeight: "600" }}>✦ Copilot</Text>
          <View style={{ flex: 1 }} />
          <StatusDot color={copilot?.available ? colors.ok : colors.bad} />
        </View>

        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="Describe what to build…"
          placeholderTextColor={colors.faint}
          multiline
          style={{
            backgroundColor: colors.bg,
            borderColor: prompt.trim() ? colors.accent : colors.borderSoft,
            borderWidth: 1,
            borderRadius: 12,
            color: colors.text,
            padding: space.md,
            minHeight: 76,
            fontSize: 15,
            textAlignVertical: "top",
          }}
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.sm }}
        >
          {projects.map((project) => {
            const active = project.project_id === chosenProject?.project_id;
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

        <Button
          disabled={busy || !copilot?.available || prompt.trim().length === 0 || !chosenProject}
          label={
            busy
              ? "starting…"
              : copilot?.available
                ? "Start session"
                : (copilot?.detail ?? "checking Copilot…")
          }
          onPress={() => void start()}
        />
        {error ? <Text style={{ ...type_.caption, color: colors.bad }}>{error}</Text> : null}
      </Card>

      {ongoing.length > 0 ? (
        <>
          <SectionLabel>Ongoing · {ongoing.length}</SectionLabel>
          {ongoing.map((s) => sessionCard(s, true))}
        </>
      ) : null}

      {external.length > 0 ? (
        <>
          <SectionLabel>From your laptop</SectionLabel>
          {external.map((item) => {
            const resumable = item.project_id !== null && copilot?.available;
            return (
              <Card
                key={item.native_id}
                onPress={resumable ? () => void resume(item) : undefined}
                style={{ marginBottom: space.sm, gap: 6, opacity: resumable ? 1 : 0.55 }}
              >
                <Text style={{ ...type_.body, fontWeight: "600" }} numberOfLines={1}>
                  💻 {item.title}
                </Text>
                <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
                  <Pill tone={resumable ? "accent" : "dim"}>
                    {resuming === item.native_id
                      ? "resuming…"
                      : resumable
                        ? "continue here ›"
                        : "project not indexed"}
                  </Pill>
                  <Text style={type_.caption}>
                    {item.project_id ? projectName(item.project_id) : "—"} ·{" "}
                    {relativeTime(item.updated_at)}
                  </Text>
                </View>
              </Card>
            );
          })}
        </>
      ) : null}

      <SectionLabel>History</SectionLabel>
      {history.map((s) => sessionCard(s, false))}
      {history.length === 0 && ongoing.length === 0 ? (
        <EmptyState
          icon="✦"
          title="No sessions yet"
          caption="Sessions run on your computer and keep going even when this phone disconnects. Transcripts are kept here."
        />
      ) : null}
    </ScrollView>
  );
}

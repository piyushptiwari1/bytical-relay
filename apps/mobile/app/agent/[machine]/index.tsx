import type { AgentSession } from "@rdc/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  agentArchive,
  agentList,
  agentResume,
  agentStart,
  type ExternalSession,
  hasScope,
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
const LIVE = new Set(["starting", "running", "awaiting_approval"]);

function relativeTime(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function AgentsHome() {
  const { machine, project: focusParam } = useLocalSearchParams<{
    machine: string;
    project?: string;
  }>();
  const focusProject = focusParam ? decodeURIComponent(focusParam) : null;
  const router = useRouter();
  const projects = useApp((s) => (machine ? (s.runtime[machine]?.projects ?? []) : []));
  const scopes = useApp((s) => (machine ? s.runtime[machine]?.health?.scopes : undefined));
  const pendingPromptCounts = useApp((s) =>
    machine ? (s.runtime[machine]?.pending_prompt_counts ?? {}) : {},
  );
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [external, setExternal] = useState<ExternalSession[]>([]);
  const [resuming, setResuming] = useState<string | null>(null);
  const [providers, setProviders] = useState<
    Array<{ id: string; available: boolean; detail: string }>
  >([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"build" | "plan" | "ask">("build");
  const [model, setModel] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
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
  const canControl = hasScope(scopes, "agents.control");
  const copilot = providers.find((p) => p.id === "copilot");
  const availableProviders = providers.filter((p) => p.available);
  const chosenProvider =
    providers.find((p) => p.id === providerId && p.available) ??
    (copilot?.available ? copilot : availableProviders[0]);
  const providerLabel = (id: string) =>
    id === "copilot" ? "Copilot" : id === "claude" ? "Claude" : id;
  const chosenProject =
    projects.find((p) => p.project_id === (projectId ?? focusProject ?? "")) ?? projects[0];
  const inScope = (pid: string | null) => focusProject === null || pid === focusProject;
  const scopedSessions = sessions.filter((s) => inScope(s.project_id));
  const scopedExternal = external.filter((e) => inScope(e.project_id));
  const ongoing = scopedSessions.filter((s) => LIVE.has(s.status));
  const history = scopedSessions.filter((s) => !LIVE.has(s.status));
  const projectName = (id: string) =>
    projects.find((p) => p.project_id === id)?.name ?? id.slice(0, 12);

  const start = async () => {
    if (!canControl || !chosenProject || !chosenProvider || prompt.trim().length === 0) return;
    setBusy(true);
    try {
      const { session } = await agentStart(
        machine,
        chosenProject.project_id,
        chosenProvider.id,
        prompt.trim(),
        { mode, ...(model.trim() ? { model: model.trim() } : {}) },
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
      onLongPress={
        canControl
          ? () => {
              Alert.alert("Archive chat?", session.title, [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Archive",
                  style: "destructive",
                  onPress: () => {
                    void agentArchive(machine, session.session_id)
                      .then(() =>
                        setSessions((prev) =>
                          prev.filter((s) => s.session_id !== session.session_id),
                        ),
                      )
                      .catch((cause) => setError(String(cause)));
                  },
                },
              ]);
            }
          : undefined
      }
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
        {(session.queued_prompt_count ?? 0) > 0 ? (
          <Pill tone="accent">{session.queued_prompt_count} queued</Pill>
        ) : null}
        {(pendingPromptCounts[session.session_id] ?? 0) > 0 ? (
          <Pill tone="warn">{pendingPromptCounts[session.session_id]} waiting to send</Pill>
        ) : null}
      </View>
    </Card>
  );

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
    >
      {focusProject ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginBottom: space.md,
            gap: space.sm,
          }}
        >
          <Text style={{ ...type_.title, flex: 1 }} numberOfLines={1}>
            ✦ {projectName(focusProject)}
          </Text>
          <Text
            style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}
            onPress={() => router.setParams({ project: undefined })}
          >
            All chats ›
          </Text>
        </View>
      ) : null}
      {/* composer — "New session in <project> with <provider>" */}
      <Card style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Text style={type_.caption}>New session in</Text>
          <Text style={{ ...type_.caption, color: colors.text, fontWeight: "600" }}>
            📁 {chosenProject?.name ?? "—"}
          </Text>
          <Text style={type_.caption}>with</Text>
          <Text style={{ ...type_.caption, color: colors.text, fontWeight: "600" }}>
            ✦ {chosenProvider ? providerLabel(chosenProvider.id) : "—"}
          </Text>
          <View style={{ flex: 1 }} />
          <StatusDot color={chosenProvider?.available ? colors.ok : colors.bad} />
        </View>

        {providers.length > 1 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {providers.map((p) => {
              const active = chosenProvider?.id === p.id;
              return (
                <Pressable
                  key={p.id}
                  disabled={!p.available}
                  onPress={() => setProviderId(p.id)}
                  style={{
                    backgroundColor: active ? colors.accentSoft : "transparent",
                    borderColor: active ? colors.accent : colors.border,
                    borderWidth: 1,
                    borderRadius: 999,
                    paddingHorizontal: 12,
                    paddingVertical: 5,
                    opacity: p.available ? 1 : 0.45,
                  }}
                >
                  <Text style={{ color: active ? colors.accent : colors.dim, fontSize: 12.5 }}>
                    {providerLabel(p.id)}
                    {p.available ? "" : " · not installed"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder={
            mode === "build"
              ? "Describe what to build…"
              : mode === "plan"
                ? "What should be planned? (read-only — no changes)"
                : "Ask about this workspace (read-only)"
          }
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

        {/* job profile — controller-ENFORCED permissions, not a suggestion */}
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          {(
            [
              { id: "build", label: "▸ Build", hint: "full edit" },
              { id: "plan", label: "▤ Plan", hint: "read-only" },
              { id: "ask", label: "? Ask", hint: "read-only" },
            ] as const
          ).map((profile) => {
            const active = mode === profile.id;
            return (
              <Pressable
                key={profile.id}
                onPress={() => setMode(profile.id)}
                style={{
                  backgroundColor: active ? colors.accentSoft : "transparent",
                  borderColor: active ? colors.accent : colors.border,
                  borderWidth: 1,
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 5,
                }}
              >
                <Text style={{ color: active ? colors.accent : colors.dim, fontSize: 12.5 }}>
                  {profile.label}
                  {active ? ` · ${profile.hint}` : ""}
                </Text>
              </Pressable>
            );
          })}
          <View style={{ flex: 1 }} />
          <Text
            style={{ ...type_.caption, textDecorationLine: "underline" }}
            onPress={() => setAdvanced((v) => !v)}
          >
            {advanced ? "less" : "advanced"}
          </Text>
        </View>

        {advanced ? (
          <TextInput
            value={model}
            onChangeText={setModel}
            placeholder="Model override (e.g. claude-sonnet-4.5) — blank = provider default"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            style={{
              backgroundColor: colors.bg,
              borderColor: colors.borderSoft,
              borderWidth: 1,
              borderRadius: 10,
              color: colors.text,
              paddingHorizontal: space.md,
              paddingVertical: 8,
              fontSize: 13,
            }}
          />
        ) : null}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.sm }}
        >
          {(focusProject ? [] : projects).map((project) => {
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
          disabled={
            busy ||
            !canControl ||
            !chosenProvider?.available ||
            prompt.trim().length === 0 ||
            !chosenProject
          }
          label={
            busy
              ? "starting…"
              : !canControl
                ? "Work controls unavailable"
                : chosenProvider?.available
                  ? `Start with ${providerLabel(chosenProvider.id)}`
                  : (chosenProvider?.detail ?? "no agent provider available")
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

      {scopedExternal.length > 0 ? (
        <>
          <SectionLabel>From your laptop</SectionLabel>
          {scopedExternal.map((item) => {
            const resumable = item.project_id !== null && copilot?.available && canControl;
            const isVsCode = item.provider === "vscode-chat";
            return (
              <Card
                key={item.native_id}
                onPress={resumable ? () => void resume(item) : undefined}
                style={{ marginBottom: space.sm, gap: 6, opacity: resumable ? 1 : 0.55 }}
              >
                <Text style={{ ...type_.body, fontWeight: "600" }} numberOfLines={1}>
                  {isVsCode ? "🧩" : "💻"} {item.title}
                </Text>
                <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
                  <Pill tone={resumable ? "accent" : "dim"}>
                    {resuming === item.native_id
                      ? "importing…"
                      : resumable
                        ? isVsCode
                          ? "continue with Copilot ›"
                          : "continue here ›"
                        : "project not indexed"}
                  </Pill>
                  <Text style={type_.caption}>
                    {isVsCode ? "VS Code chat · " : ""}
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

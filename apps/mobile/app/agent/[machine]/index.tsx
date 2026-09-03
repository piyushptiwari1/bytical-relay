import type { AgentSession } from "@rdc/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { humanError } from "../../../src/errors.ts";
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

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(date, today)) return "Today";
  if (same(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
  // cached-first: last known sessions render instantly, the fetch refreshes them
  const [sessions, setSessions] = useState<AgentSession[]>(() =>
    machine ? (useApp.getState().runtime[machine]?.sessions ?? []) : [],
  );
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
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
      setError(humanError(cause));
    } finally {
      setLoaded(true);
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
  const projectName = (id: string) =>
    projects.find((p) => p.project_id === id)?.name ?? id.slice(0, 12);
  const inScope = (pid: string | null) => focusProject === null || pid === focusProject;
  const matchesQuery = (title: string, pid: string | null) =>
    query.trim().length === 0 ||
    title.toLowerCase().includes(query.trim().toLowerCase()) ||
    (pid ? projectName(pid).toLowerCase().includes(query.trim().toLowerCase()) : false);
  const scopedSessions = sessions.filter(
    (s) => inScope(s.project_id) && matchesQuery(s.title, s.project_id),
  );
  const scopedExternal = external.filter(
    (e) => inScope(e.project_id) && matchesQuery(e.title, e.project_id),
  );
  const ongoing = scopedSessions.filter((s) => LIVE.has(s.status));
  const history = scopedSessions.filter((s) => !LIVE.has(s.status));
  const historyGroups: Array<{ label: string; items: AgentSession[] }> = [];
  for (const item of history) {
    const label = dayLabel(item.updated_at);
    const group = historyGroups.at(-1);
    if (group?.label === label) group.items.push(item);
    else historyGroups.push({ label, items: [item] });
  }

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
      setError(humanError(cause));
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
      setError(humanError(cause));
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
                      .catch((cause) => setError(humanError(cause)));
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
          <Pressable
            onPress={() => router.setParams({ project: undefined })}
            style={({ pressed }) => ({
              borderColor: colors.accent,
              borderWidth: 1,
              borderRadius: 999,
              paddingHorizontal: 12,
              paddingVertical: 5,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
              All chats ›
            </Text>
          </Pressable>
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
          <StatusDot
            color={!loaded ? colors.warn : chosenProvider?.available ? colors.ok : colors.bad}
          />
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
              : !loaded && !chosenProvider
                ? "checking agents on your computer…"
                : !canControl
                  ? "Work controls unavailable"
                  : chosenProvider?.available
                    ? `Start with ${providerLabel(chosenProvider.id)}`
                    : "No AI agent on this computer yet"
          }
          onPress={() => void start()}
        />
        {loaded && availableProviders.length === 0 ? (
          <View
            style={{
              gap: 6,
              backgroundColor: colors.warnSoft,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: 10,
              padding: space.md,
            }}
          >
            <Text style={{ ...type_.caption, color: colors.text, fontWeight: "600" }}>
              Relay needs an AI agent on the computer
            </Text>
            {providers.map((p) => (
              <Text key={p.id} style={type_.caption}>
                · {providerLabel(p.id)} — {p.detail}
              </Text>
            ))}
            <Text style={type_.caption}>
              Install GitHub Copilot CLI (npm install -g @github/copilot) or Claude Code on that
              computer, then recheck.
            </Text>
            <Pressable
              onPress={() => {
                setLoaded(false);
                void load();
              }}
              style={({ pressed }) => ({
                alignSelf: "flex-start",
                borderColor: colors.accent,
                borderWidth: 1,
                borderRadius: 999,
                paddingHorizontal: 14,
                paddingVertical: 6,
                marginTop: 4,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
                ↻ Recheck now
              </Text>
            </Pressable>
          </View>
        ) : null}
        {error ? <Text style={{ ...type_.caption, color: colors.bad }}>{error}</Text> : null}
      </Card>

      {sessions.length + external.length > 4 ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search chats…"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          style={{
            backgroundColor: colors.card,
            borderColor: query.trim() ? colors.accent : colors.borderSoft,
            borderWidth: 1,
            borderRadius: 12,
            color: colors.text,
            paddingHorizontal: space.md,
            paddingVertical: 9,
            fontSize: 14,
            marginTop: space.lg,
          }}
        />
      ) : null}

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
                onPress={
                  resumable
                    ? () => void resume(item)
                    : () =>
                        Alert.alert(
                          "Can't continue this chat yet",
                          item.project_id === null
                            ? "This chat's folder isn't indexed by Relay on your computer — open it there once, or add it to the project roots."
                            : !copilot?.available
                              ? `GitHub Copilot CLI isn't available on the computer — ${copilot?.detail ?? "install it there, then recheck"}.`
                              : "Work controls are unavailable for this phone — re-pair with supervised access.",
                        )
                }
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

      {!loaded && sessions.length === 0 ? (
        <>
          <SectionLabel>History</SectionLabel>
          {[0, 1, 2].map((i) => (
            <Card key={`skeleton-${i}`} style={{ marginBottom: space.sm, gap: 8, opacity: 0.55 }}>
              <View
                style={{
                  height: 13,
                  width: `${72 - i * 14}%`,
                  borderRadius: 6,
                  backgroundColor: colors.border,
                }}
              />
              <View
                style={{
                  height: 10,
                  width: "38%",
                  borderRadius: 5,
                  backgroundColor: colors.borderSoft,
                }}
              />
            </Card>
          ))}
        </>
      ) : (
        <>
          {historyGroups.map((group) => (
            <View key={group.label}>
              <SectionLabel>{group.label}</SectionLabel>
              {group.items.map((s) => sessionCard(s, false))}
            </View>
          ))}
          {history.length === 0 && ongoing.length === 0 ? (
            query.trim() ? (
              <EmptyState icon="○" title="No matches" caption="Try a different search." />
            ) : (
              <EmptyState
                icon="✦"
                title="No sessions yet"
                caption="Sessions run on your computer and keep going even when this phone disconnects. Transcripts are kept here."
              />
            )
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

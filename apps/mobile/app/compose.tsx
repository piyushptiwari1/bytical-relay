import { useLocalSearchParams, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { humanError } from "../src/errors.ts";
import { agentList, agentStart, useApp } from "../src/machines.ts";
import { Button, colors, space, type_ } from "../src/theme.tsx";

const LAST_MACHINE_KEY = "relay.compose.machine";
const LAST_PROJECT_KEY = "relay.compose.project";

/** ChatGPT-simple new chat: one input, context as chips, everything remembered. */
export default function Compose() {
  const router = useRouter();
  const params = useLocalSearchParams<{ machine?: string; project?: string }>();
  const machines = useApp((s) => s.machines);
  const runtime = useApp((s) => s.runtime);

  const [machineId, setMachineId] = useState<string | null>(params.machine ?? null);
  const [projectId, setProjectId] = useState<string | null>(params.project ?? null);
  const [providers, setProviders] = useState<
    Array<{ id: string; available: boolean; detail: string }>
  >([]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"build" | "plan" | "ask">("build");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // context restore: last used machine + project, falling back to the first available
  useEffect(() => {
    void (async () => {
      if (!machineId) {
        const saved = await SecureStore.getItemAsync(LAST_MACHINE_KEY);
        const candidate =
          machines.find((m) => m.machine_id === saved)?.machine_id ?? machines[0]?.machine_id;
        if (candidate) setMachineId(candidate);
      }
    })();
  }, [machineId, machines]);
  useEffect(() => {
    void (async () => {
      if (machineId && !projectId) {
        const saved = await SecureStore.getItemAsync(LAST_PROJECT_KEY);
        const projects = runtime[machineId]?.projects ?? [];
        const candidate =
          projects.find((p) => p.project_id === saved)?.project_id ?? projects[0]?.project_id;
        if (candidate) setProjectId(candidate);
      }
    })();
  }, [machineId, projectId, runtime]);

  const loadProviders = useCallback(async () => {
    if (!machineId) return;
    try {
      const result = await agentList(machineId);
      setProviders(result.providers);
      setError(null);
    } catch (cause) {
      setError(humanError(cause));
    }
  }, [machineId]);
  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const machine = machines.find((m) => m.machine_id === machineId);
  const projects = machineId ? (runtime[machineId]?.projects ?? []) : [];
  const project = projects.find((p) => p.project_id === projectId) ?? projects[0];
  const available = providers.filter((p) => p.available);
  const chosenProvider =
    providers.find((p) => p.id === providerId && p.available) ??
    available.find((p) => p.id === "copilot") ??
    available[0];
  const providerLabel = (id: string) =>
    id === "copilot" ? "Copilot" : id === "claude" ? "Claude" : id;

  const start = async () => {
    if (!machineId || !project || !chosenProvider || prompt.trim().length === 0) return;
    setBusy(true);
    try {
      await SecureStore.setItemAsync(LAST_MACHINE_KEY, machineId);
      await SecureStore.setItemAsync(LAST_PROJECT_KEY, project.project_id);
      const { session } = await agentStart(
        machineId,
        project.project_id,
        chosenProvider.id,
        prompt.trim(),
        { mode },
      );
      router.replace(`/agent/${machineId}/${session.session_id}`);
    } catch (cause) {
      setError(humanError(cause));
      setBusy(false);
    }
  };

  const chip = (active: boolean, label: string, onPress: () => void, key: string) => (
    <Pressable
      key={key}
      onPress={onPress}
      style={{
        backgroundColor: active ? colors.accentSoft : "transparent",
        borderColor: active ? colors.accent : colors.border,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 7,
      }}
    >
      <Text style={{ color: active ? colors.accent : colors.dim, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl }}
      keyboardShouldPersistTaps="handled"
    >
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        autoFocus
        multiline
        placeholder="What should the agent do?"
        placeholderTextColor={colors.faint}
        style={{
          backgroundColor: colors.card,
          borderColor: prompt.trim() ? colors.accent : colors.borderSoft,
          borderWidth: 1,
          borderRadius: 16,
          color: colors.text,
          padding: space.lg,
          minHeight: 120,
          fontSize: 16,
          lineHeight: 23,
          textAlignVertical: "top",
        }}
      />

      {machines.length > 1 ? (
        <View style={{ gap: space.sm }}>
          <Text style={type_.micro}>Computer</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: space.sm }}
          >
            {machines.map((m) =>
              chip(
                m.machine_id === machineId,
                m.name,
                () => {
                  setMachineId(m.machine_id);
                  setProjectId(null);
                  setProviders([]);
                },
                m.machine_id,
              ),
            )}
          </ScrollView>
        </View>
      ) : null}

      <View style={{ gap: space.sm }}>
        <Text style={type_.micro}>Project on {machine?.name ?? "…"}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.sm }}
        >
          {projects.map((p) =>
            chip(
              p.project_id === project?.project_id,
              p.name,
              () => setProjectId(p.project_id),
              p.project_id,
            ),
          )}
        </ScrollView>
        {projects.length === 0 ? (
          <Text style={type_.caption}>
            No projects indexed on this computer yet — open a project folder there once.
          </Text>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        {(
          [
            { id: "build", label: "Build" },
            { id: "plan", label: "Plan · read-only" },
            { id: "ask", label: "Ask · read-only" },
          ] as const
        ).map((profile) =>
          chip(mode === profile.id, profile.label, () => setMode(profile.id), profile.id),
        )}
        {providers.length > 1 ? (
          <>
            <View style={{ width: 1, height: 18, backgroundColor: colors.borderSoft }} />
            {providers.map((p) =>
              chip(
                chosenProvider?.id === p.id,
                p.available ? providerLabel(p.id) : `${providerLabel(p.id)} · not installed`,
                () => p.available && setProviderId(p.id),
                p.id,
              ),
            )}
          </>
        ) : null}
      </View>

      <Button
        disabled={busy || !chosenProvider || prompt.trim().length === 0 || !project}
        label={
          busy
            ? "starting…"
            : chosenProvider
              ? `Start with ${providerLabel(chosenProvider.id)}`
              : providers.length > 0
                ? "No AI agent on this computer yet"
                : "checking agents…"
        }
        onPress={() => void start()}
      />
      {error ? <Text style={{ ...type_.caption, color: colors.bad }}>{error}</Text> : null}
      {providers.length > 0 && available.length === 0 ? (
        <Text style={type_.caption}>
          Install the Copilot CLI on {machine?.name ?? "the computer"}: VS Code → Relay sidebar →
          “Install Copilot CLI”, then reopen this screen.
        </Text>
      ) : null}
    </ScrollView>
  );
}

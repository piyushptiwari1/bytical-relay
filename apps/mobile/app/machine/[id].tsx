import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { hasScope, useApp } from "../../src/machines.ts";
import {
  Button,
  colors,
  EmptyState,
  formatGb,
  ListRow,
  Pill,
  SectionLabel,
  space,
  type_,
} from "../../src/theme.tsx";

export default function MachineDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const machine = useApp((s) => s.machines.find((m) => m.machine_id === id));
  const rt = useApp((s) => (id ? s.runtime[id] : undefined));
  const refresh = useApp((s) => s.refreshMachine);
  const connect = useApp((s) => s.connect);
  const forget = useApp((s) => s.forget);

  useEffect(() => {
    if (id) void refresh(id).catch(() => connect(id));
  }, [id, refresh, connect]);

  if (!machine || !id)
    return <Text style={{ ...type_.caption, padding: space.xl }}>machine not found</Text>;
  const health = rt?.health;
  const canReadAgents = hasScope(health?.scopes, "agents.read");
  const canReadTerminal = hasScope(health?.scopes, "terminals.read");
  const canReadFiles = hasScope(health?.scopes, "files.read");
  const canReadGit = hasScope(health?.scopes, "git.read");

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            marginBottom: space.sm,
          }}
        >
          <Text style={{ ...type_.title, flex: 1 }} numberOfLines={1}>
            {machine.name}
          </Text>
          <Pill tone={rt?.state === "ready" ? "ok" : "dim"}>{rt?.state ?? "idle"}</Pill>
        </View>

        <SectionLabel>Work</SectionLabel>
        {canReadAgents ? (
          <ListRow
            icon={<Text style={{ color: colors.accent2, fontSize: 15 }}>✦</Text>}
            label="Agents"
            description="Chats with Copilot / Claude on this machine"
            trailing={<Text style={{ color: colors.accent, fontSize: 16 }}>›</Text>}
            onPress={() => router.push(`/agent/${id}`)}
          />
        ) : null}
        {canReadTerminal ? (
          <ListRow
            icon={<Text style={{ color: colors.dim, fontSize: 14 }}>⌨</Text>}
            label="Terminals"
            description="Persistent shells on this machine"
            trailing={<Text style={{ color: colors.accent, fontSize: 16 }}>›</Text>}
            onPress={() => router.push(`/terminal/${id}`)}
          />
        ) : null}
        {(rt?.editors ?? []).map((editor) => (
          <ListRow
            key={editor.editor_id}
            icon={<Text style={{ color: colors.accent, fontSize: 14 }}>◈</Text>}
            label={`VS Code${editor.workspace ? ` — ${editor.workspace}` : ""}`}
            description={
              editor.active_file
                ? `✎ ${editor.active_file.name}${editor.active_file.line ? `:${editor.active_file.line}` : ""}`
                : "no file focused"
            }
            trailing={
              editor.diagnostics.errors > 0 ? (
                <Pill tone="bad">{editor.diagnostics.errors} errors</Pill>
              ) : editor.diagnostics.warnings > 0 ? (
                <Pill tone="warn">{editor.diagnostics.warnings} warnings</Pill>
              ) : editor.running_tasks.length > 0 ? (
                <Pill tone="accent">▶ {editor.running_tasks.length}</Pill>
              ) : (
                <Pill tone="ok">no problems</Pill>
              )
            }
          />
        ))}

        <SectionLabel>Projects · {rt?.projects?.length ?? 0} — tap for chats</SectionLabel>
        {(rt?.projects ?? []).map((project) => (
          <ListRow
            key={project.project_id}
            icon={<Text style={{ color: colors.accent2, fontSize: 13 }}>✦</Text>}
            label={project.name}
            description={project.root_path}
            onPress={
              canReadAgents
                ? () =>
                    router.push(`/agent/${id}?project=${encodeURIComponent(project.project_id)}`)
                : undefined
            }
            trailing={
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                {project.wsl ? <Pill tone="dim">WSL</Pill> : null}
                {canReadFiles ? (
                  <RowAction
                    label="Files"
                    onPress={() =>
                      router.push(`/project/${id}/${encodeURIComponent(project.project_id)}`)
                    }
                  />
                ) : null}
                {project.vcs === "git" && canReadGit ? (
                  <RowAction
                    label="⎇ Git"
                    onPress={() =>
                      router.push(`/git/${id}/${encodeURIComponent(project.project_id)}`)
                    }
                  />
                ) : null}
              </View>
            }
          />
        ))}
        {rt?.projects?.length === 0 ? (
          <EmptyState
            icon="○"
            title="No projects indexed"
            caption="Open a project folder on the computer once, or add it to the controller's project roots."
          />
        ) : null}

        <View style={{ marginTop: space.xl }}>
          <Button
            kind="danger"
            label="Forget this machine"
            onPress={() => {
              void forget(id);
              router.replace("/");
            }}
          />
        </View>
      </ScrollView>

      {/* status strip — the VS Code status bar analog */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: space.md,
          paddingHorizontal: space.lg,
          paddingVertical: 7,
          borderTopWidth: 1,
          borderTopColor: colors.borderSoft,
          backgroundColor: colors.card,
        }}
      >
        <Text
          style={{ ...type_.caption, color: rt?.state === "ready" ? colors.accent : colors.dim }}
        >
          {rt?.transport === "relay" ? "☁ relay" : "⇄ Wi-Fi"}
        </Text>
        {health ? (
          <>
            {health.cpu.load_percent !== null ? (
              <Text style={type_.caption}>CPU {health.cpu.load_percent}%</Text>
            ) : null}
            <Text style={type_.caption}>
              {formatGb(health.memory.total_bytes - health.memory.free_bytes)} used
            </Text>
            {health.network.latency_ms !== null ? (
              <Text style={type_.caption}>{health.network.latency_ms}ms</Text>
            ) : null}
            {health.battery ? (
              <Text style={type_.caption}>
                ▢ {health.battery.percent}%{health.battery.charging ? "⚡" : ""}
              </Text>
            ) : null}
            {health.keep_awake?.enabled ? (
              <Text style={{ ...type_.caption, color: colors.warn }}>☕ awake</Text>
            ) : null}
          </>
        ) : (
          <Text style={type_.caption}>waiting for telemetry…</Text>
        )}
        <View style={{ flex: 1 }} />
        <Text style={type_.caption}>up {health ? Math.floor(health.uptime_s / 3600) : "—"}h</Text>
      </View>
    </View>
  );
}

function RowAction(props: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 7,
        paddingHorizontal: 9,
        paddingVertical: 4,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "600" }}>{props.label}</Text>
    </Pressable>
  );
}

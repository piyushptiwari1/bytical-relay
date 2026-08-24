import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { ScrollView, Text, View } from "react-native";
import { useApp } from "../../src/machines.ts";
import {
  Button,
  Card,
  colors,
  formatGb,
  Pill,
  SectionLabel,
  StatusDot,
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

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl }}
    >
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ ...type_.title, flex: 1 }}>{machine.name}</Text>
          {rt?.transport === "relay" ? <Pill tone="accent">☁ relay</Pill> : null}
          <Pill tone={rt?.state === "ready" ? "ok" : "dim"}>{rt?.state ?? "idle"}</Pill>
        </View>
        {health ? (
          <>
            <Text style={type_.caption}>
              {health.platform}/{health.arch} · up {Math.floor(health.uptime_s / 3600)}h ·{" "}
              {health.cpu.cores} cores
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg, marginTop: 4 }}>
              <Stat
                label="CPU"
                value={health.cpu.load_percent !== null ? `${health.cpu.load_percent}%` : "—"}
              />
              <Stat
                label="Memory"
                value={`${formatGb(health.memory.total_bytes - health.memory.free_bytes)} of ${formatGb(health.memory.total_bytes)}`}
              />
              {health.disks.map((d) => (
                <Stat key={d.drive} label={d.drive} value={`${formatGb(d.free_bytes)} free`} />
              ))}
              {health.battery ? (
                <Stat
                  label="Battery"
                  value={`${health.battery.percent}%${health.battery.charging ? " ⚡" : ""}`}
                />
              ) : null}
              {health.network.latency_ms !== null ? (
                <Stat label="Latency" value={`${health.network.latency_ms}ms`} />
              ) : null}
            </View>
            {health.gpu ? <Text style={type_.caption}>GPU · {health.gpu}</Text> : null}
          </>
        ) : (
          <Text style={type_.caption}>waiting for telemetry…</Text>
        )}
      </Card>

      <Card accent onPress={() => router.push(`/agent/${id}`)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ fontSize: 20 }}>✦</Text>
          <View style={{ flex: 1 }}>
            <Text style={type_.heading}>Agents</Text>
            <Text style={type_.caption}>Run Copilot on this machine from your phone</Text>
          </View>
          <Text style={{ color: colors.accent, fontSize: 18 }}>›</Text>
        </View>
      </Card>

      {(rt?.editors ?? []).map((editor) => (
        <Card key={editor.editor_id}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <StatusDot color={colors.accent} />
            <Text style={{ ...type_.heading, flex: 1 }} numberOfLines={1}>
              VS Code{editor.workspace ? ` — ${editor.workspace}` : ""}
            </Text>
          </View>
          {editor.active_file ? (
            <Text style={{ ...type_.body, color: colors.accent }} numberOfLines={1}>
              ✎ {editor.active_file.name}
              {editor.active_file.line ? `:${editor.active_file.line}` : ""}
            </Text>
          ) : (
            <Text style={type_.caption}>no file focused</Text>
          )}
          <View style={{ flexDirection: "row", gap: space.sm }}>
            {editor.diagnostics.errors > 0 ? (
              <Pill tone="bad">{editor.diagnostics.errors} errors</Pill>
            ) : null}
            {editor.diagnostics.warnings > 0 ? (
              <Pill tone="warn">{editor.diagnostics.warnings} warnings</Pill>
            ) : null}
            {editor.diagnostics.errors === 0 && editor.diagnostics.warnings === 0 ? (
              <Pill tone="ok">no problems</Pill>
            ) : null}
            {editor.running_tasks.length > 0 ? (
              <Pill tone="accent">▶ {editor.running_tasks.join(", ")}</Pill>
            ) : null}
          </View>
          {editor.last_command ? (
            <Text style={{ ...type_.caption, fontFamily: "monospace" }} numberOfLines={1}>
              $ {editor.last_command.command}
              {editor.last_command.exit_code !== null
                ? ` → ${editor.last_command.exit_code}`
                : " …"}
            </Text>
          ) : null}
        </Card>
      ))}

      <Card onPress={() => router.push(`/terminal/${id}`)} style={{ gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ ...type_.heading, flex: 1 }}>⌨ Terminals</Text>
          <Text style={{ color: colors.accent, fontSize: 16 }}>›</Text>
        </View>
        <Text style={type_.caption}>Persistent shells on this machine</Text>
      </Card>

      <SectionLabel>Projects — tap for chats</SectionLabel>
      {(rt?.projects ?? []).map((project) => (
        <Card
          key={project.project_id}
          onPress={() =>
            router.push(`/agent/${id}?project=${encodeURIComponent(project.project_id)}`)
          }
          style={{ gap: space.xs }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Text style={{ ...type_.heading, flex: 1 }} numberOfLines={1}>
              ✦ {project.name}
            </Text>
            {project.wsl ? <Pill tone="dim">WSL</Pill> : null}
            <Text style={{ color: colors.accent, fontSize: 16 }}>›</Text>
          </View>
          <Text style={type_.caption} numberOfLines={1}>
            {project.root_path}
          </Text>
          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.xs }}>
            <Button
              small
              kind="ghost"
              label="Files"
              onPress={() =>
                router.push(`/project/${id}/${encodeURIComponent(project.project_id)}`)
              }
            />
            {project.vcs === "git" ? (
              <Button
                small
                kind="ghost"
                label="⎇ Git"
                onPress={() => router.push(`/git/${id}/${encodeURIComponent(project.project_id)}`)}
              />
            ) : null}
          </View>
        </Card>
      ))}
      {rt?.projects?.length === 0 ? (
        <Text style={type_.caption}>No projects detected on this machine.</Text>
      ) : null}

      <View style={{ marginTop: space.lg }}>
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
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <View style={{ gap: 1, minWidth: 90 }}>
      <Text style={type_.micro}>{props.label}</Text>
      <Text style={{ ...type_.body, fontSize: 13 }}>{props.value}</Text>
    </View>
  );
}

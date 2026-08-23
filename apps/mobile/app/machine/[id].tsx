import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useApp } from "../../src/machines.ts";
import { colors, formatGb } from "../../src/theme.ts";

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
    return <Text style={{ color: colors.dim, padding: 20 }}>machine not found</Text>;
  const health = rt?.health;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View
        style={{
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 14,
          gap: 4,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>{machine.name}</Text>
        <Text style={{ color: colors.dim, fontSize: 12 }}>
          {rt?.state ?? "idle"} · {machine.machine_id}
        </Text>
        {health ? (
          <>
            <Text style={{ color: colors.dim, fontSize: 12 }}>
              {health.platform}/{health.arch} · up {Math.floor(health.uptime_s / 3600)}h ·{" "}
              {health.cpu.model}
            </Text>
            <Text style={{ color: colors.dim, fontSize: 12 }}>
              RAM {formatGb(health.memory.total_bytes - health.memory.free_bytes)}/
              {formatGb(health.memory.total_bytes)}
              {health.cpu.load_percent !== null ? ` · CPU ${health.cpu.load_percent}%` : ""}
            </Text>
            {health.disks.map((d) => (
              <Text key={d.drive} style={{ color: colors.dim, fontSize: 12 }}>
                {d.drive} {formatGb(d.free_bytes)} free of {formatGb(d.total_bytes)}
              </Text>
            ))}
            {health.gpu ? (
              <Text style={{ color: colors.dim, fontSize: 12 }}>GPU {health.gpu}</Text>
            ) : null}
          </>
        ) : null}
      </View>

      {(rt?.editors ?? []).map((editor) => (
        <View
          key={editor.editor_id}
          style={{
            backgroundColor: colors.card,
            borderColor: colors.accent,
            borderWidth: 1,
            borderRadius: 10,
            padding: 14,
            gap: 4,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>
            ✎ VS Code{editor.workspace ? ` — ${editor.workspace}` : ""}
          </Text>
          {editor.active_file ? (
            <Text style={{ color: colors.accent, fontSize: 13 }}>
              editing {editor.active_file.name}
              {editor.active_file.line ? `:${editor.active_file.line}` : ""}
            </Text>
          ) : (
            <Text style={{ color: colors.dim, fontSize: 13 }}>no file focused</Text>
          )}
          <Text style={{ color: colors.dim, fontSize: 12 }}>
            {editor.diagnostics.errors > 0 ? `⛔ ${editor.diagnostics.errors} ` : ""}
            {editor.diagnostics.warnings > 0 ? `⚠ ${editor.diagnostics.warnings} ` : ""}
            {editor.diagnostics.errors === 0 && editor.diagnostics.warnings === 0
              ? "no problems "
              : ""}
            {editor.running_tasks.length > 0 ? `· running: ${editor.running_tasks.join(", ")}` : ""}
          </Text>
          {editor.last_command ? (
            <Text style={{ color: colors.dim, fontSize: 11 }} numberOfLines={1}>
              $ {editor.last_command.command}
              {editor.last_command.exit_code !== null
                ? ` → ${editor.last_command.exit_code}`
                : " …"}
            </Text>
          ) : null}
        </View>
      ))}

      <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>Projects</Text>
      {(rt?.projects ?? []).map((project) => (
        <View
          key={project.project_id}
          style={{
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 10,
            padding: 14,
            gap: 6,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>
            {project.name}
            {project.wsl ? " · WSL" : ""}
          </Text>
          <Text style={{ color: colors.dim, fontSize: 11 }}>{project.root_path}</Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
            <Pressable
              onPress={() =>
                router.push(`/project/${id}/${encodeURIComponent(project.project_id)}`)
              }
              style={{
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 8,
                paddingHorizontal: 16,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: colors.accent }}>Files</Text>
            </Pressable>
            {project.vcs === "git" ? (
              <Pressable
                onPress={() => router.push(`/git/${id}/${encodeURIComponent(project.project_id)}`)}
                style={{
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  paddingHorizontal: 16,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: colors.accent }}>⎇ Git</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ))}
      {rt?.projects?.length === 0 ? (
        <Text style={{ color: colors.dim }}>No projects detected on this machine.</Text>
      ) : null}

      <Pressable
        onPress={() => {
          void forget(id);
          router.replace("/");
        }}
        style={{ alignItems: "center", padding: 12 }}
      >
        <Text style={{ color: colors.bad }}>Forget this machine</Text>
      </Pressable>
    </ScrollView>
  );
}

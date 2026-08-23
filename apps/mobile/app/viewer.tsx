import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { openInEditor, readFile } from "../src/machines.ts";
import { colors, mono } from "../src/theme.ts";

export default function Viewer() {
  const { machine, project, path, name } = useLocalSearchParams<{
    machine: string;
    project: string;
    path: string;
    name: string;
  }>();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ok"; content: string; truncated: boolean; size: number; binary: boolean }
  >({ status: "loading" });
  const [openNote, setOpenNote] = useState<string | null>(null);

  useEffect(() => {
    if (!machine || !project || !path) return;
    readFile(machine, decodeURIComponent(project), path)
      .then((file) =>
        setState({
          status: "ok",
          content: file.encoding === "utf8" ? file.content : "",
          binary: file.encoding === "base64",
          truncated: file.truncated,
          size: file.size,
        }),
      )
      .catch((cause) =>
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
  }, [machine, project, path]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
      <Text style={{ color: colors.dim, fontSize: 12, marginBottom: 8 }}>{name ?? path}</Text>
      {machine && project && path ? (
        <Pressable
          onPress={() => {
            void openInEditor(machine, decodeURIComponent(project), path)
              .then((r) =>
                setOpenNote(r.delivered > 0 ? "opened in VS Code ✓" : "VS Code not open"),
              )
              .catch((cause) =>
                setOpenNote(cause instanceof Error ? cause.message : String(cause)),
              );
          }}
          style={{
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 8,
            paddingVertical: 8,
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <Text style={{ color: colors.accent, fontSize: 13 }}>
            {openNote ?? "Open in VS Code on desktop"}
          </Text>
        </Pressable>
      ) : null}
      {state.status === "loading" ? <Text style={{ color: colors.dim }}>loading…</Text> : null}
      {state.status === "error" ? <Text style={{ color: colors.bad }}>{state.message}</Text> : null}
      {state.status === "ok" ? (
        state.binary ? (
          <Text style={{ color: colors.dim }}>Binary file · {state.size} bytes</Text>
        ) : (
          <>
            {state.truncated ? (
              <Text style={{ color: colors.warn, marginBottom: 8 }}>
                showing first 256 KB of {state.size} bytes
              </Text>
            ) : null}
            <ScrollView horizontal>
              <Text style={{ color: colors.text, ...mono, fontSize: 12, lineHeight: 18 }}>
                {state.content}
              </Text>
            </ScrollView>
          </>
        )
      ) : null}
    </ScrollView>
  );
}

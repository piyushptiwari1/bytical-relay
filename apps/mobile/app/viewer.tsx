import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { humanError } from "../src/errors.ts";
import { openInEditor, readFile } from "../src/machines.ts";
import { Button, colors, mono, space, type_ } from "../src/theme.tsx";

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
          message: humanError(cause),
        }),
      );
  }, [machine, project, path]);

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          gap: space.sm,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
        }}
      >
        <Text style={{ ...type_.caption, ...mono }} numberOfLines={1}>
          {path ?? name}
        </Text>
        {machine && project && path ? (
          <Button
            small
            kind="ghost"
            label={openNote ?? "Open in VS Code on desktop"}
            onPress={() => {
              void openInEditor(machine, decodeURIComponent(project), path)
                .then((r) =>
                  setOpenNote(r.delivered > 0 ? "Opened in VS Code ✓" : "VS Code isn’t open"),
                )
                .catch((cause) => setOpenNote(humanError(cause)));
            }}
          />
        ) : null}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.lg }}>
        {state.status === "loading" ? <Text style={type_.caption}>loading…</Text> : null}
        {state.status === "error" ? (
          <Text style={{ ...type_.body, color: colors.bad }}>{state.message}</Text>
        ) : null}
        {state.status === "ok" ? (
          state.binary ? (
            <Text style={type_.caption}>Binary file · {state.size} bytes</Text>
          ) : (
            <>
              {state.truncated ? (
                <Text style={{ ...type_.caption, color: colors.warn, marginBottom: space.sm }}>
                  Showing first 256 KB of {state.size} bytes
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
    </View>
  );
}

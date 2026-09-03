import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { humanError } from "../src/errors.ts";
import { gitDiffFile } from "../src/machines.ts";
import { colors, mono, space, type_ } from "../src/theme.tsx";

function lineStyle(line: string): { color: string; backgroundColor?: string } {
  if (line.startsWith("+") && !line.startsWith("+++"))
    return { color: colors.ok, backgroundColor: colors.okSoft };
  if (line.startsWith("-") && !line.startsWith("---"))
    return { color: colors.bad, backgroundColor: colors.badSoft };
  if (line.startsWith("@@")) return { color: colors.accent, backgroundColor: colors.accentSoft };
  if (line.startsWith("diff ") || line.startsWith("index ")) return { color: colors.faint };
  return { color: colors.text };
}

export default function GitDiff() {
  const params = useLocalSearchParams<{
    machine: string;
    project: string;
    path: string;
    staged: string;
  }>();
  const [lines, setLines] = useState<string[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.machine || !params.project || !params.path) return;
    gitDiffFile(params.machine, params.project, params.path, params.staged === "1")
      .then((diff) => {
        if (diff.binary) {
          setNote("Binary file — no text diff.");
          setLines([]);
          return;
        }
        if (diff.truncated) setNote("Diff truncated at 512 KB.");
        setLines(diff.patch.length === 0 ? [] : diff.patch.split("\n"));
      })
      .catch((cause) => setError(humanError(cause)));
  }, [params.machine, params.project, params.path, params.staged]);

  if (error) {
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: space.xl }}>
        <Text style={{ ...type_.body, color: colors.bad, textAlign: "center" }}>{error}</Text>
      </View>
    );
  }
  if (!lines) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
        }}
      >
        <Text style={{ ...type_.caption, ...mono }} numberOfLines={1}>
          {params.path}
          {params.staged === "1" ? "  ·  staged" : ""}
        </Text>
        {note ? (
          <Text style={{ ...type_.caption, color: colors.warn, marginTop: 2 }}>{note}</Text>
        ) : null}
      </View>
      {lines.length === 0 && !note ? (
        <Text style={{ ...type_.caption, padding: space.lg }}>No changes.</Text>
      ) : null}
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingVertical: space.sm }}
        data={lines}
        keyExtractor={(_, i) => String(i)}
        initialNumToRender={60}
        renderItem={({ item }) => {
          const style = lineStyle(item);
          return (
            <Text
              style={{
                ...style,
                ...mono,
                fontSize: 12,
                lineHeight: 18,
                paddingHorizontal: space.lg,
              }}
            >
              {item.length === 0 ? " " : item}
            </Text>
          );
        }}
      />
    </View>
  );
}

import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { gitDiffFile } from "../src/machines.ts";
import { colors, mono } from "../src/theme.ts";

function lineColor(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return colors.ok;
  if (line.startsWith("-") && !line.startsWith("---")) return colors.bad;
  if (line.startsWith("@@")) return colors.accent;
  if (line.startsWith("diff ") || line.startsWith("index ")) return colors.dim;
  return colors.text;
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
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [params.machine, params.project, params.path, params.staged]);

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ color: colors.bad, textAlign: "center" }}>{error}</Text>
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
      <Text style={{ color: colors.dim, fontSize: 12, paddingHorizontal: 12, paddingTop: 8 }}>
        {params.path}
        {params.staged === "1" ? " · staged" : ""}
      </Text>
      {note ? (
        <Text style={{ color: colors.warn, fontSize: 12, paddingHorizontal: 12 }}>{note}</Text>
      ) : null}
      {lines.length === 0 && !note ? (
        <Text style={{ color: colors.dim, padding: 12 }}>No changes.</Text>
      ) : null}
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12 }}
        data={lines}
        keyExtractor={(_, i) => String(i)}
        initialNumToRender={60}
        renderItem={({ item }) => (
          <Text style={{ color: lineColor(item), ...mono, fontSize: 12, lineHeight: 17 }}>
            {item.length === 0 ? " " : item}
          </Text>
        )}
      />
    </View>
  );
}

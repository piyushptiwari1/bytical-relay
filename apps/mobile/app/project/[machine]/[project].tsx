import type { FileEntry } from "@rdc/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { listEntries, watchProject } from "../../../src/machines.ts";
import { colors, mono } from "../../../src/theme.ts";

interface Crumb {
  parentId: string | null;
  name: string;
}

export default function ProjectBrowser() {
  const { machine, project } = useLocalSearchParams<{ machine: string; project: string }>();
  const router = useRouter();
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ parentId: null, name: "/" }]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [live, setLive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const current = crumbs[crumbs.length - 1] ?? { parentId: null, name: "/" };
  const reloading = useRef(false);

  const load = useCallback(async () => {
    if (!machine || !project || reloading.current) return;
    reloading.current = true;
    try {
      setEntries(await listEntries(machine, decodeURIComponent(project), current.parentId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      reloading.current = false;
    }
  }, [machine, project, current.parentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!machine || !project) return;
    return watchProject(machine, decodeURIComponent(project), () => {
      setLive((n) => n + 1);
      void load();
    });
  }, [machine, project, load]);

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          padding: 10,
          gap: 4,
          alignItems: "center",
        }}
      >
        {crumbs.map((crumb, i) => (
          <Pressable
            key={crumbs
              .slice(0, i + 1)
              .map((c) => c.name)
              .join("/")}
            onPress={() => setCrumbs(crumbs.slice(0, i + 1))}
          >
            <Text
              style={{
                color: i === crumbs.length - 1 ? colors.text : colors.accent,
                ...mono,
                fontSize: 13,
              }}
            >
              {crumb.name}
              {i < crumbs.length - 1 ? " ›" : ""}
            </Text>
          </Pressable>
        ))}
        {live > 0 ? <Text style={{ color: colors.ok, fontSize: 11 }}> · live ({live})</Text> : null}
      </View>
      {error ? <Text style={{ color: colors.bad, paddingHorizontal: 12 }}>{error}</Text> : null}
      <FlatList
        data={entries}
        keyExtractor={(entry) => entry.file_id}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => {
              if (item.kind === "dir") {
                setCrumbs([...crumbs, { parentId: item.file_id, name: item.name }]);
              } else {
                router.push({
                  pathname: "/viewer",
                  params: { machine, project, path: item.relative_path, name: item.name },
                });
              }
            }}
            style={{
              flexDirection: "row",
              paddingVertical: 8,
              paddingHorizontal: 14,
              gap: 8,
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 14 }}>{item.kind === "dir" ? "📁" : "📄"}</Text>
            <Text
              style={{
                color: item.kind === "dir" ? colors.accent : colors.text,
                ...mono,
                fontSize: 13,
                flex: 1,
              }}
            >
              {item.name}
            </Text>
            {item.kind === "file" ? (
              <Text style={{ color: colors.dim, fontSize: 11 }}>{item.size} B</Text>
            ) : null}
          </Pressable>
        )}
      />
    </View>
  );
}

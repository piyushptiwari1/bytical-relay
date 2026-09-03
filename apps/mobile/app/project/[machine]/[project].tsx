import type { FileEntry, KnownMessage } from "@rdc/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { humanError } from "../../../src/errors.ts";
import { listEntries, watchProject } from "../../../src/machines.ts";
import { colors, EmptyState, mono, space, type_ } from "../../../src/theme.tsx";

interface Crumb {
  name: string;
  parentId: string | null;
}

export default function ProjectBrowser() {
  const { machine, project } = useLocalSearchParams<{ machine: string; project: string }>();
  const router = useRouter();
  const projectId = project ? decodeURIComponent(project) : "";
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ name: "root", parentId: null }]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(0);

  const load = useCallback(
    async (parentId: string | null) => {
      if (!machine || !projectId) return;
      try {
        setEntries(await listEntries(machine, projectId, parentId));
        setError(null);
      } catch (cause) {
        setError(humanError(cause));
      }
    },
    [machine, projectId],
  );

  const current = crumbs.at(-1);
  useEffect(() => {
    void load(current?.parentId ?? null);
  }, [load, current?.parentId]);

  useEffect(() => {
    if (!machine || !projectId) return;
    return watchProject(machine, projectId, (_msg: KnownMessage) => {
      setLive((n) => n + 1);
      void load(crumbs.at(-1)?.parentId ?? null);
    });
  }, [machine, projectId, load, crumbs]);

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          gap: 4,
          alignItems: "center",
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
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
              {i < crumbs.length - 1 ? "  ›  " : ""}
            </Text>
          </Pressable>
        ))}
        {live > 0 ? (
          <Text style={{ color: colors.ok, fontSize: 10, marginLeft: 6 }}>● live</Text>
        ) : null}
      </View>
      {error ? (
        <Text style={{ ...type_.caption, color: colors.bad, padding: space.lg }}>{error}</Text>
      ) : null}
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingVertical: space.sm }}
        data={entries}
        keyExtractor={(entry) => entry.file_id}
        ListEmptyComponent={error ? null : <EmptyState icon="🗂" title="Empty folder" />}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => {
              if (item.kind === "dir") {
                setCrumbs([...crumbs, { name: item.name, parentId: item.file_id }]);
              } else {
                router.push({
                  pathname: "/viewer",
                  params: {
                    machine,
                    project: encodeURIComponent(projectId),
                    path: item.relative_path,
                    name: item.name,
                  },
                });
              }
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              paddingHorizontal: space.lg,
              paddingVertical: 11,
              backgroundColor: pressed ? colors.card : "transparent",
            })}
          >
            <Text style={{ fontSize: 15, width: 22 }}>{item.kind === "dir" ? "📁" : "📄"}</Text>
            <Text style={{ ...type_.body, flex: 1 }} numberOfLines={1}>
              {item.name}
            </Text>
            {item.kind === "file" ? (
              <Text style={type_.caption}>{formatSize(item.size)}</Text>
            ) : (
              <Text style={{ color: colors.faint, fontSize: 14 }}>›</Text>
            )}
          </Pressable>
        )}
      />
    </View>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

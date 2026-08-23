import type { GitFileStatus, GitState } from "@rdc/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { gitCommit, gitStage, gitStatus, gitUnstage, watchGit } from "../../../src/machines.ts";
import { colors, mono } from "../../../src/theme.ts";

const GLYPH: Record<string, string> = {
  M: "M",
  A: "A",
  D: "D",
  R: "R",
  C: "C",
  U: "U",
  "?": "?",
  ".": " ",
};

function glyphColor(char: string): string {
  if (char === "A" || char === "?") return colors.ok;
  if (char === "D") return colors.bad;
  if (char === "U") return colors.warn;
  return colors.accent;
}

export default function GitScreen() {
  const { machine, project } = useLocalSearchParams<{ machine: string; project: string }>();
  const router = useRouter();
  const [state, setState] = useState<GitState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!machine || !project) return;
    try {
      setState(await gitStatus(machine, project));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [machine, project]);

  useEffect(() => {
    void load();
    if (!machine || !project) return;
    return watchGit(machine, project, setState);
  }, [machine, project, load]);

  if (!machine || !project) return null;
  if (error) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ color: colors.bad, textAlign: "center" }}>{error}</Text>
      </View>
    );
  }
  if (!state) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const staged = state.files.filter((f) => f.index !== "." && !f.untracked && !f.conflicted);
  const unstaged = state.files.filter(
    (f) => (f.worktree !== "." || f.untracked || f.conflicted) && !staged.includes(f),
  );

  const act = async (fn: () => Promise<GitState | undefined>) => {
    setBusy(true);
    try {
      const next = await fn();
      if (next) setState(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const row = (file: GitFileStatus, isStaged: boolean) => {
    const char = isStaged ? file.index : file.untracked ? "?" : file.worktree;
    return (
      <View
        key={`${isStaged ? "s" : "w"}:${file.path}`}
        style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6, gap: 8 }}
      >
        <Text style={{ color: glyphColor(char), width: 16, ...mono, fontSize: 14 }}>
          {GLYPH[char] ?? char}
        </Text>
        <Pressable
          style={{ flex: 1 }}
          onPress={() =>
            router.push({
              pathname: "/gitdiff",
              params: {
                machine,
                project,
                path: file.path,
                staged: isStaged ? "1" : "0",
              },
            })
          }
        >
          <Text style={{ color: colors.text, fontSize: 13 }} numberOfLines={1}>
            {file.orig_path ? `${file.orig_path} → ` : ""}
            {file.path}
          </Text>
        </Pressable>
        <Pressable
          disabled={busy}
          onPress={() =>
            void act(() =>
              isStaged
                ? gitUnstage(machine, project, [file.path])
                : gitStage(machine, project, [file.path]),
            )
          }
          style={{
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 6,
            paddingHorizontal: 10,
            paddingVertical: 4,
          }}
        >
          <Text style={{ color: colors.accent, fontSize: 12 }}>{isStaged ? "−" : "+"}</Text>
        </Pressable>
      </View>
    );
  };

  return (
    <FlatList
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 14, gap: 4 }}
      data={[]}
      renderItem={() => null}
      ListHeaderComponent={
        <View style={{ gap: 10 }}>
          <View
            style={{
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: 10,
              padding: 12,
              gap: 2,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>
              ⎇ {state.detached ? "detached" : (state.branch ?? "no branch")}
            </Text>
            <Text style={{ color: colors.dim, fontSize: 12 }}>
              {state.upstream ? `${state.upstream} · ` : ""}
              {state.ahead > 0 ? `↑${state.ahead} ` : ""}
              {state.behind > 0 ? `↓${state.behind} ` : ""}
              {state.oid ? state.oid.slice(0, 8) : "no commits yet"}
            </Text>
          </View>

          {staged.length > 0 ? (
            <>
              <Text style={{ color: colors.ok, fontSize: 13, fontWeight: "600" }}>
                Staged ({staged.length})
              </Text>
              {staged.map((f) => row(f, true))}
              <TextInput
                value={message}
                onChangeText={setMessage}
                placeholder="Commit message"
                placeholderTextColor={colors.dim}
                multiline
                style={{
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  color: colors.text,
                  padding: 10,
                  minHeight: 44,
                }}
              />
              <Pressable
                disabled={busy || message.trim().length === 0}
                onPress={() =>
                  void act(async () => {
                    await gitCommit(machine, project, message.trim());
                    setMessage("");
                    return gitStatus(machine, project);
                  })
                }
                style={{
                  backgroundColor: message.trim() ? colors.accent : colors.card,
                  borderRadius: 8,
                  alignItems: "center",
                  paddingVertical: 10,
                }}
              >
                <Text style={{ color: message.trim() ? colors.bg : colors.dim, fontWeight: "600" }}>
                  {busy ? "…" : `Commit ${staged.length} file(s)`}
                </Text>
              </Pressable>
            </>
          ) : null}

          <Text style={{ color: colors.warn, fontSize: 13, fontWeight: "600" }}>
            Changes ({unstaged.length})
          </Text>
          {unstaged.map((f) => row(f, false))}
          {state.files.length === 0 ? (
            <Text style={{ color: colors.dim, paddingVertical: 12 }}>Working tree clean ✓</Text>
          ) : null}
        </View>
      }
    />
  );
}

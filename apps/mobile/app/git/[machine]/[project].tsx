import type { GitFileStatus, GitState } from "@rdc/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { humanError } from "../../../src/errors.ts";
import {
  gitCommit,
  gitStage,
  gitStatus,
  gitUnstage,
  hasScope,
  useApp,
  watchGit,
} from "../../../src/machines.ts";
import {
  Button,
  Card,
  colors,
  EmptyState,
  mono,
  Pill,
  SectionLabel,
  space,
  type_,
} from "../../../src/theme.tsx";

function glyphColor(char: string): string {
  if (char === "A" || char === "?") return colors.ok;
  if (char === "D") return colors.bad;
  if (char === "U") return colors.warn;
  return colors.accent;
}

export default function GitScreen() {
  const { machine, project } = useLocalSearchParams<{ machine: string; project: string }>();
  const router = useRouter();
  const scopes = useApp((s) => (machine ? s.runtime[machine]?.health?.scopes : undefined));
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
      setError(humanError(cause));
    }
  }, [machine, project]);

  useEffect(() => {
    void load();
    if (!machine || !project) return;
    return watchGit(machine, project, setState);
  }, [machine, project, load]);

  if (!machine || !project) return null;
  const canWrite = hasScope(scopes, "git.write");
  if (error) {
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: space.xl }}>
        <Text style={{ ...type_.body, color: colors.bad, textAlign: "center" }}>{error}</Text>
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
      setError(humanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const row = (file: GitFileStatus, isStaged: boolean) => {
    const char = isStaged ? file.index : file.untracked ? "?" : file.worktree;
    return (
      <View
        key={`${isStaged ? "s" : "w"}:${file.path}`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 9,
          gap: space.md,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
        }}
      >
        <Text style={{ color: glyphColor(char), width: 16, ...mono, fontSize: 14 }}>{char}</Text>
        <Pressable
          style={{ flex: 1 }}
          onPress={() =>
            router.push({
              pathname: "/gitdiff",
              params: { machine, project, path: file.path, staged: isStaged ? "1" : "0" },
            })
          }
        >
          <Text style={type_.body} numberOfLines={1}>
            {file.orig_path ? `${file.orig_path} → ` : ""}
            {file.path}
          </Text>
        </Pressable>
        {canWrite ? (
          <Pressable
            disabled={busy}
            onPress={() =>
              void act(() =>
                isStaged
                  ? gitUnstage(machine, project, [file.path])
                  : gitStage(machine, project, [file.path]),
              )
            }
            style={({ pressed }) => ({
              width: 30,
              height: 30,
              borderRadius: 15,
              borderWidth: 1,
              borderColor: colors.border,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? colors.cardRaised : "transparent",
            })}
          >
            <Text style={{ color: colors.accent, fontSize: 16, lineHeight: 18 }}>
              {isStaged ? "−" : "+"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
    >
      <Card style={{ gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ ...type_.heading, flex: 1 }}>
            ⎇ {state.detached ? "detached" : (state.branch ?? "no branch")}
          </Text>
          {state.ahead > 0 ? <Pill tone="accent">↑{state.ahead}</Pill> : null}
          {state.behind > 0 ? <Pill tone="warn">↓{state.behind}</Pill> : null}
        </View>
        <Text style={type_.caption}>
          {state.upstream ? `${state.upstream} · ` : ""}
          {state.oid ? state.oid.slice(0, 8) : "no commits yet"}
        </Text>
      </Card>

      {staged.length > 0 ? (
        <>
          <SectionLabel>Staged · {staged.length}</SectionLabel>
          {staged.map((f) => row(f, true))}
          {canWrite ? (
            <View style={{ gap: space.sm, marginTop: space.md }}>
              <TextInput
                value={message}
                onChangeText={setMessage}
                placeholder="Commit message"
                placeholderTextColor={colors.faint}
                multiline
                style={{
                  backgroundColor: colors.card,
                  borderColor: colors.borderSoft,
                  borderWidth: 1,
                  borderRadius: 12,
                  color: colors.text,
                  padding: space.md,
                  minHeight: 48,
                  fontSize: 14,
                }}
              />
              <Button
                disabled={busy || message.trim().length === 0}
                label={
                  busy
                    ? "committing…"
                    : `Commit ${staged.length} file${staged.length > 1 ? "s" : ""}`
                }
                onPress={() =>
                  void act(async () => {
                    await gitCommit(machine, project, message.trim());
                    setMessage("");
                    return gitStatus(machine, project);
                  })
                }
              />
            </View>
          ) : (
            <Text style={{ ...type_.caption, marginTop: space.md }}>
              Review is enabled on this phone. Staging and commits stay on the computer.
            </Text>
          )}
        </>
      ) : null}

      <SectionLabel>Changes · {unstaged.length}</SectionLabel>
      {unstaged.map((f) => row(f, false))}
      {state.files.length === 0 ? (
        <EmptyState
          icon="✓"
          title="Working tree clean"
          caption="Edits on the laptop appear here live."
        />
      ) : null}
    </ScrollView>
  );
}

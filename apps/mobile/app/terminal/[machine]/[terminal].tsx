import type { TerminalSnapshot } from "@rdc/protocol";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { humanError } from "../../../src/errors.ts";
import {
  hasScope,
  terminalKill,
  terminalSnapshot,
  terminalWrite,
  useApp,
  watchTerminal,
} from "../../../src/machines.ts";
import { colors, mono, Pill, space, type_ } from "../../../src/theme.tsx";

const CTRL_KEYS: Array<{ label: string; data: string }> = [
  { label: "Tab", data: "\t" },
  { label: "↑", data: "\u001b[A" },
  { label: "↓", data: "\u001b[B" },
  { label: "^C", data: "\u0003" },
  { label: "^D", data: "\u0004" },
  { label: "^L", data: "\u000c" },
];

export default function TerminalScreen() {
  const { machine, terminal } = useLocalSearchParams<{ machine: string; terminal: string }>();
  const scopes = useApp((s) => (machine ? s.runtime[machine]?.health?.scopes : undefined));
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null);
  const [input, setInput] = useState("");
  const [exited, setExited] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const fetching = useRef(false);
  const pendingRefetch = useRef(false);

  const refresh = useCallback(async () => {
    if (!machine || !terminal) return;
    if (fetching.current) {
      pendingRefetch.current = true;
      return;
    }
    fetching.current = true;
    try {
      setSnapshot(await terminalSnapshot(machine, terminal));
      setError(null);
    } catch (cause) {
      setError(humanError(cause));
    } finally {
      fetching.current = false;
      if (pendingRefetch.current) {
        pendingRefetch.current = false;
        void refresh();
      }
    }
  }, [machine, terminal]);

  useEffect(() => {
    void refresh();
    if (!machine || !terminal) return;
    return watchTerminal(
      machine,
      terminal,
      () => void refresh(),
      (code) => setExited(code),
    );
  }, [machine, terminal, refresh]);

  if (!machine || !terminal) return null;
  const canControl = hasScope(scopes, "terminals.control");

  const send = async (data: string) => {
    try {
      await terminalWrite(machine, terminal, data);
    } catch (cause) {
      setError(humanError(cause));
    }
  };

  const submit = () => {
    void send(`${input}\r`);
    setInput("");
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#0A0C10" }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.lg,
          paddingVertical: space.sm,
          gap: space.sm,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
        }}
      >
        {exited !== undefined ? (
          <Pill tone="dim">exited {exited ?? "?"}</Pill>
        ) : (
          <Pill tone="ok">live</Pill>
        )}
        {error ? (
          <Text style={{ ...type_.caption, color: colors.bad, flex: 1 }} numberOfLines={1}>
            {error}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {canControl ? (
          <Pressable
            onPress={() => void terminalKill(machine, terminal).then(() => setExited(null))}
          >
            <Text style={{ color: colors.bad, fontSize: 13, fontWeight: "600" }}>Kill</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.md }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            {(snapshot?.lines ?? []).map((line, i) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: terminal rows are positional
                key={i}
                style={{ ...mono, fontSize: 11.5, lineHeight: 16, color: colors.text }}
              >
                {line.spans.length === 0 ? " " : null}
                {line.spans.map((span, j) => (
                  <Text
                    // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional runs
                    key={j}
                    style={{
                      color: span.fg ?? colors.text,
                      backgroundColor: span.bg ?? undefined,
                      fontWeight: span.bold ? "700" : "400",
                    }}
                  >
                    {span.text}
                  </Text>
                ))}
              </Text>
            ))}
          </View>
        </ScrollView>
      </ScrollView>

      {canControl ? (
        <View
          style={{
            flexDirection: "row",
            gap: space.xs,
            paddingHorizontal: space.md,
            paddingTop: space.xs,
          }}
        >
          {CTRL_KEYS.map((key) => (
            <Pressable
              key={key.label}
              onPress={() => void send(key.data)}
              style={({ pressed }) => ({
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 6,
                backgroundColor: pressed ? colors.cardRaised : "transparent",
              })}
            >
              <Text style={{ color: colors.dim, fontSize: 12, ...mono }}>{key.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", padding: space.md, gap: space.sm }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          onSubmitEditing={submit}
          editable={canControl && exited === undefined}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={
            !canControl
              ? "Terminal input is not enabled"
              : exited === undefined
                ? "Type a command…"
                : "terminal exited"
          }
          placeholderTextColor={colors.faint}
          style={{
            flex: 1,
            backgroundColor: colors.card,
            borderColor: colors.borderSoft,
            borderWidth: 1,
            borderRadius: 10,
            color: colors.text,
            paddingHorizontal: 14,
            paddingVertical: 9,
            fontSize: 13,
            ...mono,
          }}
        />
        <Pressable
          disabled={!canControl || exited !== undefined || input.length === 0}
          onPress={submit}
          style={({ pressed }) => ({
            backgroundColor:
              canControl && input && exited === undefined ? colors.accent : colors.card,
            borderRadius: 10,
            paddingHorizontal: 16,
            justifyContent: "center",
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text
            style={{
              color: canControl && input && exited === undefined ? "#0A0C10" : colors.faint,
              fontWeight: "700",
            }}
          >
            ↵
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

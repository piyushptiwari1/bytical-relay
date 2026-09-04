import type { TerminalInfo } from "@rdc/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { humanError } from "../../../src/errors.ts";
import {
  hasScope,
  terminalCreate,
  terminalKill,
  terminalList,
  useApp,
} from "../../../src/machines.ts";
import {
  colors,
  EmptyState,
  ListRow,
  Pill,
  SectionLabel,
  StatusDot,
  space,
  type_,
} from "../../../src/theme.tsx";

export default function TerminalsHome() {
  const { machine } = useLocalSearchParams<{ machine: string }>();
  const router = useRouter();
  const scopes = useApp((s) => (machine ? s.runtime[machine]?.health?.scopes : undefined));
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [shells, setShells] = useState<Array<{ id: string; label: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!machine) return;
    try {
      const result = await terminalList(machine);
      setTerminals(result.terminals);
      setShells(result.shells);
      setError(null);
    } catch (cause) {
      setError(humanError(cause));
    }
  }, [machine]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!machine) return null;
  const canControl = hasScope(scopes, "terminals.control");

  const open = async (shell: string) => {
    setBusy(true);
    try {
      const { terminal } = await terminalCreate(machine, { shell });
      router.push(`/terminal/${machine}/${terminal.terminal_id}`);
      void load();
    } catch (cause) {
      setError(humanError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
    >
      {error ? <Text style={{ ...type_.caption, color: colors.bad }}>{error}</Text> : null}

      {canControl ? (
        <>
          <SectionLabel>New terminal</SectionLabel>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {shells.map((shell) => (
              <Pressable
                key={shell.id}
                disabled={busy}
                onPress={() => void open(shell.id)}
                style={({ pressed }) => ({
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: 10,
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  backgroundColor: pressed ? colors.cardRaised : colors.card,
                })}
              >
                <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
                  + {shell.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : (
        <Text style={{ ...type_.caption, marginTop: space.md }}>
          This phone can view terminal output. Command input is not enabled.
        </Text>
      )}

      <SectionLabel>Open terminals</SectionLabel>
      {terminals.map((terminal) => (
        <ListRow
          key={terminal.terminal_id}
          icon={<StatusDot color={terminal.alive ? colors.ok : colors.faint} />}
          label={terminal.title}
          description={terminal.cwd}
          trailing={
            <Pill tone={terminal.alive ? "ok" : "dim"}>{terminal.alive ? "live" : "exited"}</Pill>
          }
          onPress={() => router.push(`/terminal/${machine}/${terminal.terminal_id}`)}
          onLongPress={
            canControl
              ? () => {
                  Alert.alert("Kill terminal?", terminal.title, [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Kill",
                      style: "destructive",
                      onPress: () => {
                        void terminalKill(machine, terminal.terminal_id).then(() => load());
                      },
                    },
                  ]);
                }
              : undefined
          }
        />
      ))}
      {terminals.length === 0 ? (
        <EmptyState
          icon="⌨"
          title="No terminals yet"
          caption="Terminals keep running on your computer even when the phone disconnects."
        />
      ) : null}
    </ScrollView>
  );
}

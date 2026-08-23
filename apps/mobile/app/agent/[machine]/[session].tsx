import type { ApprovalRequest } from "@rdc/protocol";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import {
  agentCancel,
  agentPrompt,
  approvalRespond,
  watchAgentSession,
  watchAgentStatus,
} from "../../../src/machines.ts";
import { colors, mono } from "../../../src/theme.ts";

type Block =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "thought"; text: string }
  | { id: string; kind: "tool"; toolId: string; title: string; status: string }
  | { id: string; kind: "plan"; entries: Array<{ content: string; status: string }> }
  | { id: string; kind: "divider"; text: string }
  | { id: string; kind: "error"; text: string };

const toolGlyph: Record<string, string> = {
  pending: "◌",
  in_progress: "◐",
  completed: "●",
  failed: "✕",
};

export default function AgentSessionScreen() {
  const { machine, session } = useLocalSearchParams<{ machine: string; session: string }>();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [status, setStatus] = useState<string>("running");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);
  const listRef = useRef<FlatList<Block> | null>(null);

  useEffect(() => {
    if (!machine || !session) return;
    const id = () => `b${nextId.current++}`;

    const apply = (blocksNow: Block[], msg: unknown): Block[] => {
      const message = msg as {
        type: string;
        payload: {
          update?: {
            kind: string;
            text?: string;
            tool_id?: string;
            title?: string;
            status?: string;
            stop_reason?: string;
            message?: string;
            entries?: Array<{ content: string; status: string }>;
          };
          approval_id?: string;
          session?: { status: string };
        };
      };
      if (message.type === "agent.updated" && message.payload.update) {
        const update = message.payload.update;
        if (update.kind === "user_message")
          return [...blocksNow, { id: id(), kind: "user", text: update.text ?? "" }];
        if (update.kind === "message_chunk") {
          const last = blocksNow.at(-1);
          if (last?.kind === "assistant") {
            return [...blocksNow.slice(0, -1), { ...last, text: last.text + (update.text ?? "") }];
          }
          return [...blocksNow, { id: id(), kind: "assistant", text: update.text ?? "" }];
        }
        if (update.kind === "thought_chunk") {
          const last = blocksNow.at(-1);
          if (last?.kind === "thought") {
            return [...blocksNow.slice(0, -1), { ...last, text: last.text + (update.text ?? "") }];
          }
          return [...blocksNow, { id: id(), kind: "thought", text: update.text ?? "" }];
        }
        if (update.kind === "tool_call") {
          const toolId = update.tool_id ?? "tool";
          const existing = blocksNow.findLast(
            (b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool" && b.toolId === toolId,
          );
          if (existing) {
            return blocksNow.map((b) =>
              b.kind === "tool" && b.toolId === toolId
                ? {
                    ...b,
                    status: update.status ?? b.status,
                    title: update.title?.length ? update.title : b.title,
                  }
                : b,
            );
          }
          return [
            ...blocksNow,
            {
              id: id(),
              kind: "tool",
              toolId,
              title: update.title ?? "tool",
              status: update.status ?? "pending",
            },
          ];
        }
        if (update.kind === "plan")
          return [...blocksNow, { id: id(), kind: "plan", entries: update.entries ?? [] }];
        if (update.kind === "turn_ended")
          return [...blocksNow, { id: id(), kind: "divider", text: update.stop_reason ?? "done" }];
        if (update.kind === "error")
          return [...blocksNow, { id: id(), kind: "error", text: update.message ?? "error" }];
        return blocksNow;
      }
      if (message.type === "approval.requested") {
        setApproval(message.payload as unknown as ApprovalRequest);
        return blocksNow;
      }
      if (message.type === "approval.resolved") {
        setApproval(null);
        return blocksNow;
      }
      if (message.type === "agent.status_changed" && message.payload.session) {
        setStatus(message.payload.session.status);
        return blocksNow;
      }
      return blocksNow;
    };

    setBlocks([]);
    const unsubEvents = watchAgentSession(machine, session, (msg) => {
      setBlocks((prev) => apply(prev, msg));
    });
    const unsubStatus = watchAgentStatus(machine, (s) => {
      if (s.session_id === session) setStatus(s.status);
    });
    return () => {
      unsubEvents();
      unsubStatus();
    };
  }, [machine, session]);

  if (!machine || !session) return null;
  const canPrompt = status === "idle" || status === "completed";

  const send = async () => {
    if (prompt.trim().length === 0) return;
    try {
      await agentPrompt(machine, session, prompt.trim());
      setPrompt("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", padding: 10, gap: 10 }}>
        <Text style={{ color: colors.dim, fontSize: 12, flex: 1 }}>
          {status}
          {error ? ` · ${error}` : ""}
        </Text>
        {status === "running" || status === "awaiting_approval" ? (
          <Pressable onPress={() => void agentCancel(machine, session).catch(() => {})}>
            <Text style={{ color: colors.bad, fontSize: 12 }}>Cancel</Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        ref={listRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        data={blocks}
        keyExtractor={(b) => b.id}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => {
          if (item.kind === "user")
            return (
              <View
                style={{
                  alignSelf: "flex-end",
                  backgroundColor: colors.accent,
                  borderRadius: 10,
                  padding: 10,
                  maxWidth: "85%",
                }}
              >
                <Text style={{ color: colors.bg }}>{item.text}</Text>
              </View>
            );
          if (item.kind === "assistant")
            return (
              <View
                style={{
                  alignSelf: "flex-start",
                  backgroundColor: colors.card,
                  borderRadius: 10,
                  padding: 10,
                  maxWidth: "92%",
                }}
              >
                <Text style={{ color: colors.text }}>{item.text}</Text>
              </View>
            );
          if (item.kind === "thought")
            return (
              <Text style={{ color: colors.dim, fontSize: 12, fontStyle: "italic" }}>
                {item.text}
              </Text>
            );
          if (item.kind === "tool")
            return (
              <Text style={{ color: colors.warn, fontSize: 13, ...mono }}>
                {toolGlyph[item.status] ?? "○"} {item.title || item.toolId} · {item.status}
              </Text>
            );
          if (item.kind === "plan")
            return (
              <View style={{ gap: 2 }}>
                {item.entries.map((entry) => (
                  <Text
                    key={`${item.id}-${entry.content.slice(0, 40)}`}
                    style={{ color: colors.dim, fontSize: 12 }}
                  >
                    {entry.status === "completed" ? "☑" : "☐"} {entry.content}
                  </Text>
                ))}
              </View>
            );
          if (item.kind === "error")
            return <Text style={{ color: colors.bad, fontSize: 13 }}>{item.text}</Text>;
          return (
            <Text style={{ color: colors.dim, fontSize: 11, textAlign: "center" }}>
              — {item.text} —
            </Text>
          );
        }}
      />

      {approval ? (
        <View
          style={{
            backgroundColor: colors.card,
            borderColor: colors.bad,
            borderWidth: 1,
            borderRadius: 10,
            margin: 10,
            padding: 12,
            gap: 8,
          }}
        >
          <Text style={{ color: colors.text, fontWeight: "600" }}>{approval.title}</Text>
          <Text style={{ color: colors.dim, fontSize: 12 }}>tool: {approval.tool_kind}</Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {approval.options.map((option) => (
              <Pressable
                key={option.option_id}
                onPress={() =>
                  void approvalRespond(machine, approval.approval_id, option.option_id).catch(
                    (cause) => setError(String(cause)),
                  )
                }
                style={{
                  backgroundColor: option.option_kind.startsWith("allow") ? colors.ok : colors.bad,
                  borderRadius: 8,
                  paddingHorizontal: 16,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: colors.bg, fontWeight: "600" }}>{option.name}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", padding: 10, gap: 8 }}>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          editable={canPrompt}
          placeholder={canPrompt ? "Follow-up prompt…" : `agent is ${status}…`}
          placeholderTextColor={colors.dim}
          style={{
            flex: 1,
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 8,
            color: colors.text,
            paddingHorizontal: 10,
            paddingVertical: 8,
          }}
        />
        <Pressable
          disabled={!canPrompt || prompt.trim().length === 0}
          onPress={() => void send()}
          style={{
            backgroundColor: canPrompt && prompt.trim() ? colors.accent : colors.card,
            borderRadius: 8,
            justifyContent: "center",
            paddingHorizontal: 16,
          }}
        >
          <Text style={{ color: canPrompt && prompt.trim() ? colors.bg : colors.dim }}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

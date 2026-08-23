import type { ApprovalRequest } from "@rdc/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import {
  agentCancel,
  agentPrompt,
  approvalRespond,
  loadAgentTranscript,
  useApp,
  watchAgentSession,
  watchAgentStatus,
} from "../../../src/machines.ts";
import { colors, mono, Pill, type PillTone, space, type_ } from "../../../src/theme.tsx";

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
const toolColor: Record<string, string> = {
  pending: colors.dim,
  in_progress: colors.warn,
  completed: colors.ok,
  failed: colors.bad,
};
const statusTone: Record<string, PillTone> = {
  starting: "warn",
  running: "warn",
  awaiting_approval: "bad",
  idle: "ok",
  completed: "ok",
  failed: "bad",
  cancelled: "dim",
};
const ENDED = new Set(["completed", "failed", "cancelled"]);

/** VS Code-style labels for ACP permission option kinds. */
function optionLabel(kind: string, name: string): string {
  if (kind === "allow_once") return "Allow";
  if (kind === "allow_always") return "Always allow";
  if (kind === "reject_once") return "Skip";
  if (kind === "reject_always") return "Never";
  return name;
}

export default function AgentSessionScreen() {
  const { machine, session } = useLocalSearchParams<{ machine: string; session: string }>();
  const router = useRouter();
  const projects = useApp((s) => (machine ? (s.runtime[machine]?.projects ?? []) : []));
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [status, setStatus] = useState<string>("running");
  const [projectId, setProjectId] = useState<string | null>(null);
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
          session?: { status: string; project_id?: string };
        };
      };
      if (message.type === "agent.updated" && message.payload.update) {
        const update = message.payload.update;
        if (update.kind === "user_message")
          return [...blocksNow, { id: id(), kind: "user", text: update.text ?? "" }];
        if (update.kind === "message_chunk") {
          const last = blocksNow.at(-1);
          if (last?.kind === "assistant")
            return [...blocksNow.slice(0, -1), { ...last, text: last.text + (update.text ?? "") }];
          return [...blocksNow, { id: id(), kind: "assistant", text: update.text ?? "" }];
        }
        if (update.kind === "thought_chunk") {
          const last = blocksNow.at(-1);
          if (last?.kind === "thought")
            return [...blocksNow.slice(0, -1), { ...last, text: last.text + (update.text ?? "") }];
          return [...blocksNow, { id: id(), kind: "thought", text: update.text ?? "" }];
        }
        if (update.kind === "tool_call") {
          const toolId = update.tool_id ?? "tool";
          const exists = blocksNow.some((b) => b.kind === "tool" && b.toolId === toolId);
          if (exists) {
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
        if (message.payload.session.project_id) setProjectId(message.payload.session.project_id);
        return blocksNow;
      }
      return blocksNow;
    };

    setBlocks([]);
    // full history first (immune to stream-cursor state), then live pushes beyond it
    let lastSeq = -1;
    let historyDone = false;
    const backlog: Array<{ seq: number; msg: unknown }> = [];
    const seqOf = (msg: unknown): number =>
      typeof (msg as { seq?: number }).seq === "number" ? (msg as { seq: number }).seq : -1;

    const unsubEvents = watchAgentSession(machine, session, (msg) => {
      const seq = seqOf(msg);
      if (!historyDone) {
        backlog.push({ seq, msg });
        return;
      }
      if (seq > lastSeq) {
        lastSeq = seq;
        setBlocks((prev) => apply(prev, msg));
      }
    });
    void loadAgentTranscript(machine, session)
      .then(({ events, lastSeq: replayedTo }) => {
        lastSeq = replayedTo;
        setBlocks(() => {
          let next: Block[] = [];
          for (const event of events) next = apply(next, event);
          for (const item of backlog) {
            if (item.seq > lastSeq) {
              lastSeq = item.seq;
              next = apply(next, item.msg);
            }
          }
          return next;
        });
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        historyDone = true;
      });

    const unsubStatus = watchAgentStatus(machine, (s) => {
      if (s.session_id === session) {
        setStatus(s.status);
        setProjectId(s.project_id);
      }
    });
    return () => {
      unsubEvents();
      unsubStatus();
    };
  }, [machine, session]);

  if (!machine || !session) return null;
  const busy = status === "running" || status === "awaiting_approval" || status === "starting";
  const canPrompt = !busy;
  const ended = ENDED.has(status);
  const project = projects.find((p) => p.project_id === projectId);

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
      {/* context bar: project · provider · status · changes shortcut */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          gap: space.sm,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
        }}
      >
        <Text style={{ ...type_.caption, color: colors.text, fontWeight: "600" }} numberOfLines={1}>
          📁 {project?.name ?? "…"}
        </Text>
        <Pill tone={statusTone[status] ?? "dim"}>
          {status === "awaiting_approval" ? "needs approval" : status.replaceAll("_", " ")}
        </Pill>
        <View style={{ flex: 1 }} />
        {project ? (
          <Pressable
            onPress={() => router.push(`/git/${machine}/${encodeURIComponent(project.project_id)}`)}
          >
            <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>⎇ Changes</Text>
          </Pressable>
        ) : null}
        {status === "running" || status === "awaiting_approval" ? (
          <Pressable onPress={() => void agentCancel(machine, session).catch(() => {})}>
            <Text style={{ color: colors.bad, fontSize: 13, fontWeight: "600" }}>Stop</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text style={{ ...type_.caption, color: colors.bad, paddingHorizontal: space.lg }}>
          {error}
        </Text>
      ) : null}

      <FlatList
        ref={listRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, gap: space.md }}
        data={blocks}
        keyExtractor={(b) => b.id}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => {
          if (item.kind === "user")
            return (
              <View
                style={{
                  alignSelf: "flex-end",
                  backgroundColor: colors.accentSoft,
                  borderColor: colors.accent,
                  borderWidth: 1,
                  borderRadius: 16,
                  borderBottomRightRadius: 4,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  maxWidth: "85%",
                }}
              >
                <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>
                  {item.text}
                </Text>
              </View>
            );
          if (item.kind === "assistant")
            return (
              <View
                style={{
                  alignSelf: "flex-start",
                  backgroundColor: colors.card,
                  borderColor: colors.borderSoft,
                  borderWidth: 1,
                  borderRadius: 16,
                  borderBottomLeftRadius: 4,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  maxWidth: "92%",
                }}
              >
                <Text style={{ color: colors.text, fontSize: 14, lineHeight: 21 }}>
                  {item.text}
                </Text>
              </View>
            );
          if (item.kind === "thought")
            return (
              <Text style={{ ...type_.caption, fontStyle: "italic", paddingHorizontal: space.xs }}>
                {item.text}
              </Text>
            );
          if (item.kind === "tool")
            return (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  backgroundColor: colors.card,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  alignSelf: "flex-start",
                  maxWidth: "92%",
                }}
              >
                <Text style={{ color: toolColor[item.status] ?? colors.dim, fontSize: 13 }}>
                  {toolGlyph[item.status] ?? "○"}
                </Text>
                <Text
                  style={{ ...type_.caption, color: colors.text, ...mono, flexShrink: 1 }}
                  numberOfLines={1}
                >
                  {item.title || item.toolId}
                </Text>
                <Text style={{ ...type_.caption, color: toolColor[item.status] ?? colors.dim }}>
                  {item.status.replaceAll("_", " ")}
                </Text>
              </View>
            );
          if (item.kind === "plan")
            return (
              <View
                style={{
                  gap: 4,
                  backgroundColor: colors.card,
                  borderRadius: 10,
                  padding: space.md,
                }}
              >
                <Text style={type_.micro}>Plan</Text>
                {item.entries.map((entry) => (
                  <Text
                    key={`${item.id}-${entry.content.slice(0, 40)}`}
                    style={{
                      ...type_.caption,
                      color: entry.status === "completed" ? colors.ok : colors.dim,
                    }}
                  >
                    {entry.status === "completed" ? "☑" : "☐"} {entry.content}
                  </Text>
                ))}
              </View>
            );
          if (item.kind === "error")
            return (
              <Text style={{ ...type_.caption, color: colors.bad, paddingHorizontal: space.xs }}>
                {item.text}
              </Text>
            );
          return (
            <Text style={{ ...type_.micro, textAlign: "center", marginVertical: 2 }}>
              ── {item.text} ──
            </Text>
          );
        }}
      />

      {approval ? (
        <View
          style={{
            backgroundColor: colors.cardRaised,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 16,
            marginHorizontal: space.lg,
            marginBottom: space.md,
            padding: space.lg,
            gap: space.sm,
            shadowColor: "#000",
            shadowOpacity: 0.5,
            shadowRadius: 16,
            elevation: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Text style={{ fontSize: 16 }}>🛡️</Text>
            <Text style={{ ...type_.caption, flex: 1 }}>
              Copilot wants to run · {approval.tool_kind}
            </Text>
          </View>
          <Text style={{ ...type_.body, fontWeight: "600", ...mono, fontSize: 13 }}>
            {approval.title}
          </Text>
          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.xs }}>
            {[...approval.options]
              .sort((a) => (a.option_kind.startsWith("allow") ? -1 : 1))
              .map((option) => {
                const allow = option.option_kind.startsWith("allow");
                const primary = option.option_kind === "allow_once";
                return (
                  <Pressable
                    key={option.option_id}
                    onPress={() =>
                      void approvalRespond(machine, approval.approval_id, option.option_id).catch(
                        (cause) => setError(String(cause)),
                      )
                    }
                    style={({ pressed }) => ({
                      flex: primary ? 1 : undefined,
                      backgroundColor: primary
                        ? colors.accent
                        : allow
                          ? colors.accentSoft
                          : "transparent",
                      borderColor: allow ? "transparent" : colors.border,
                      borderWidth: allow ? 0 : 1,
                      borderRadius: 10,
                      paddingHorizontal: 16,
                      paddingVertical: 11,
                      alignItems: "center",
                      opacity: pressed ? 0.85 : 1,
                    })}
                  >
                    <Text
                      style={{
                        color: primary ? "#0A0C10" : allow ? colors.accent : colors.dim,
                        fontWeight: "600",
                        fontSize: 14,
                      }}
                    >
                      {optionLabel(option.option_kind, option.name)}
                    </Text>
                  </Pressable>
                );
              })}
          </View>
        </View>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          padding: space.md,
          gap: space.sm,
          borderTopWidth: 1,
          borderTopColor: colors.borderSoft,
        }}
      >
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          editable={canPrompt}
          placeholder={
            !canPrompt
              ? `agent is ${status.replaceAll("_", " ")}…`
              : ended
                ? "Continue this conversation…"
                : "Follow-up prompt…"
          }
          placeholderTextColor={colors.faint}
          style={{
            flex: 1,
            backgroundColor: colors.card,
            borderColor: colors.borderSoft,
            borderWidth: 1,
            borderRadius: 22,
            color: colors.text,
            paddingHorizontal: 16,
            paddingVertical: 10,
            fontSize: 14,
          }}
        />
        <Pressable
          disabled={!canPrompt || prompt.trim().length === 0}
          onPress={() => void send()}
          style={({ pressed }) => ({
            backgroundColor: canPrompt && prompt.trim() ? colors.accent : colors.card,
            borderRadius: 22,
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text
            style={{
              color: canPrompt && prompt.trim() ? "#0A0C10" : colors.faint,
              fontSize: 17,
              fontWeight: "700",
            }}
          >
            ↑
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { colors, mono, space, type_ } from "./theme.tsx";

/** Zero-dependency markdown for agent replies: code fences with tap-to-copy,
 * inline code, bold, headings, and lists. Unknown syntax degrades to plain text. */

type Segment =
  | { id: string; kind: "code"; lang: string; body: string }
  | { id: string; kind: "text"; body: string };

function splitFences(text: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let cursor = 0;
  let n = 0;
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    if (match.index > cursor)
      segments.push({ id: `s${n++}`, kind: "text", body: text.slice(cursor, match.index) });
    const body = match[2]?.replace(/\n$/, "") ?? "";
    if (body.trim()) segments.push({ id: `s${n++}`, kind: "code", lang: match[1] ?? "", body });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length)
    segments.push({ id: `s${n++}`, kind: "text", body: text.slice(cursor) });
  return segments;
}

/** Inline spans: `code`, **bold** — nested cases degrade gracefully. */
function inlineSpans(line: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const token = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  let i = 0;
  for (let match = token.exec(line); match; match = token.exec(line)) {
    if (match.index > cursor) nodes.push(line.slice(cursor, match.index));
    const raw = match[0];
    if (raw.startsWith("`")) {
      nodes.push(
        <Text
          key={`${keyPrefix}-c${i++}`}
          style={{ ...mono, fontSize: 12.5, color: colors.accent, backgroundColor: colors.bg }}
        >
          {` ${raw.slice(1, -1)} `}
        </Text>,
      );
    } else {
      nodes.push(
        <Text key={`${keyPrefix}-b${i++}`} style={{ fontWeight: "700" }}>
          {raw.slice(2, -2)}
        </Text>,
      );
    }
    cursor = match.index + raw.length;
  }
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

function CodeCard({ lang, body }: { lang: string; body: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void Clipboard.setStringAsync(body)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };
  return (
    <View
      style={{
        backgroundColor: colors.bg,
        borderColor: colors.borderSoft,
        borderWidth: 1,
        borderRadius: 10,
        marginVertical: 6,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.md,
          paddingVertical: 6,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
        }}
      >
        <Text style={{ ...type_.micro, color: colors.dim, flex: 1 }}>{lang || "code"}</Text>
        <Pressable onPress={copy} hitSlop={10}>
          <Text style={{ ...type_.micro, color: copied ? colors.ok : colors.accent }}>
            {copied ? "✓ copied" : "copy"}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text
          style={{ ...mono, fontSize: 12, lineHeight: 18, color: colors.text, padding: space.md }}
        >
          {body}
        </Text>
      </ScrollView>
    </View>
  );
}

function TextBlock({ body }: { body: string }) {
  const lines = body.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  for (const line of lines) {
    const key = `l${i++}`;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]?.length ?? 3;
      nodes.push(
        <Text
          key={key}
          style={{
            color: colors.text,
            fontWeight: "700",
            fontSize: level <= 2 ? 16 : 14.5,
            marginTop: 6,
            marginBottom: 2,
          }}
        >
          {inlineSpans(heading[2] ?? "", key)}
        </Text>,
      );
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const numbered = /^(\d+)\.\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      nodes.push(
        <View key={key} style={{ flexDirection: "row", gap: 6, paddingLeft: 4 }}>
          <Text style={{ color: colors.accent, fontSize: 14, lineHeight: 21 }}>
            {bullet ? "•" : `${numbered?.[1]}.`}
          </Text>
          <Text style={{ color: colors.text, fontSize: 14, lineHeight: 21, flex: 1 }}>
            {inlineSpans((bullet?.[1] ?? numbered?.[2]) as string, key)}
          </Text>
        </View>,
      );
      continue;
    }
    nodes.push(
      <Text key={key} style={{ color: colors.text, fontSize: 14, lineHeight: 21 }}>
        {inlineSpans(trimmed, key)}
      </Text>,
    );
  }
  return <View style={{ gap: 3 }}>{nodes}</View>;
}

export function RichText({ text }: { text: string }) {
  const segments = splitFences(text);
  return (
    <View style={{ gap: 2 }}>
      {segments.map((segment) =>
        segment.kind === "code" ? (
          <CodeCard key={segment.id} lang={segment.lang} body={segment.body} />
        ) : (
          <TextBlock key={segment.id} body={segment.body} />
        ),
      )}
    </View>
  );
}

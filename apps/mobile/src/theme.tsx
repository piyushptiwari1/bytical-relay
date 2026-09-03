import type { ReactNode } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";

// ── design tokens ────────────────────────────────────────────────────────────
export const colors = {
  bg: "#0A0C10",
  card: "#12151C",
  cardRaised: "#171B24",
  border: "#232936",
  borderSoft: "#1B202B",
  text: "#F2F5F9",
  dim: "#7D8590",
  faint: "#4B5563",
  // brand: cyan primary, violet secondary (matches icon/site/extension)
  accent: "#22D3EE",
  accentSoft: "#0C2830",
  accent2: "#A78BFA",
  accent2Soft: "#211B36",
  ok: "#4ADE80",
  okSoft: "#12291C",
  warn: "#FBBF24",
  warnSoft: "#2E2510",
  bad: "#F87171",
  badSoft: "#2E1616",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

export const type_ = {
  title: { fontSize: 22, fontWeight: "700" as const, letterSpacing: -0.4, color: colors.text },
  heading: { fontSize: 16, fontWeight: "600" as const, letterSpacing: -0.2, color: colors.text },
  body: { fontSize: 14, color: colors.text, lineHeight: 20 },
  caption: { fontSize: 12, color: colors.dim, lineHeight: 17 },
  micro: {
    fontSize: 11,
    color: colors.faint,
    letterSpacing: 1.1,
    textTransform: "uppercase" as const,
    fontWeight: "600" as const,
  },
} as const;

export const mono = { fontFamily: "monospace" } as const;

export function formatGb(bytes: number): string {
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

// ── shared primitives ────────────────────────────────────────────────────────
export function Card(props: {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  accent?: boolean;
  style?: ViewStyle;
}) {
  const base: ViewStyle = {
    backgroundColor: colors.card,
    borderColor: props.accent ? colors.accent : colors.borderSoft,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
    ...props.style,
  };
  if (!props.onPress && !props.onLongPress) return <View style={base}>{props.children}</View>;
  return (
    <Pressable
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      style={({ pressed }) => ({
        ...base,
        backgroundColor: pressed ? colors.cardRaised : colors.card,
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      {props.children}
    </Pressable>
  );
}

export function SectionLabel(props: { children: ReactNode }) {
  return (
    <Text style={{ ...type_.micro, marginTop: space.md, marginBottom: 2 }}>{props.children}</Text>
  );
}

const pillTone = {
  ok: { fg: colors.ok, bg: colors.okSoft },
  warn: { fg: colors.warn, bg: colors.warnSoft },
  bad: { fg: colors.bad, bg: colors.badSoft },
  dim: { fg: colors.dim, bg: colors.cardRaised },
  accent: { fg: colors.accent, bg: colors.accentSoft },
} as const;
export type PillTone = keyof typeof pillTone;

export function Pill(props: { tone: PillTone; children: ReactNode }) {
  const tone = pillTone[props.tone];
  return (
    <View
      style={{
        backgroundColor: tone.bg,
        borderRadius: radius.pill,
        paddingHorizontal: 10,
        paddingVertical: 3,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ color: tone.fg, fontSize: 11, fontWeight: "600" }}>{props.children}</Text>
    </View>
  );
}

export function Button(props: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  small?: boolean;
}) {
  const kind = props.kind ?? "primary";
  const bg =
    kind === "primary" ? colors.accent : kind === "danger" ? colors.badSoft : "transparent";
  const fg = kind === "primary" ? "#0A0C10" : kind === "danger" ? colors.bad : colors.accent;
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => ({
        backgroundColor: props.disabled ? colors.cardRaised : bg,
        borderColor: kind === "ghost" ? colors.border : "transparent",
        borderWidth: kind === "ghost" ? 1 : 0,
        borderRadius: radius.md,
        paddingVertical: props.small ? 7 : 12,
        paddingHorizontal: props.small ? 14 : 20,
        alignItems: "center",
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text
        style={{
          color: props.disabled ? colors.faint : fg,
          fontWeight: "600",
          fontSize: props.small ? 13 : 15,
        }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function StatusDot(props: { color: string }) {
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: props.color,
        shadowColor: props.color,
        shadowOpacity: 0.9,
        shadowRadius: 4,
        elevation: 2,
      }}
    />
  );
}

export function EmptyState(props: { icon: string; title: string; caption?: string }) {
  return (
    <View style={{ alignItems: "center", gap: space.sm, paddingVertical: space.xxl }}>
      <Text style={{ fontSize: 34 }}>{props.icon}</Text>
      <Text style={type_.heading}>{props.title}</Text>
      {props.caption ? (
        <Text style={{ ...type_.caption, textAlign: "center", maxWidth: 260 }}>
          {props.caption}
        </Text>
      ) : null}
    </View>
  );
}

/** VS Code-style list row: icon slot · label + description · trailing, hairline below. */
export function ListRow(props: {
  icon?: ReactNode;
  label: string;
  description?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      disabled={!props.onPress && !props.onLongPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: 44,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        backgroundColor: pressed ? colors.cardRaised : "transparent",
        borderBottomWidth: 1,
        borderBottomColor: colors.borderSoft,
      })}
    >
      {props.icon ? <View style={{ width: 22, alignItems: "center" }}>{props.icon}</View> : null}
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ ...type_.body, fontWeight: "500" }} numberOfLines={1}>
          {props.label}
        </Text>
        {props.description ? (
          <Text style={type_.caption} numberOfLines={1}>
            {props.description}
          </Text>
        ) : null}
      </View>
      {props.trailing}
    </Pressable>
  );
}

/** Chat identity mark — agent = violet ✦, you = dim monogram. */
export function Avatar(props: { kind: "agent" | "user"; glyph?: string }) {
  const agent = props.kind === "agent";
  return (
    <View
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: agent ? colors.accent2Soft : colors.cardRaised,
        borderWidth: 1,
        borderColor: agent ? colors.accent2 : colors.border,
      }}
    >
      <Text style={{ color: agent ? colors.accent2 : colors.dim, fontSize: 12, fontWeight: "700" }}>
        {props.glyph ?? (agent ? "✦" : "●")}
      </Text>
    </View>
  );
}

export function Hairline() {
  return <View style={{ height: 1, backgroundColor: colors.borderSoft, flex: 1 }} />;
}

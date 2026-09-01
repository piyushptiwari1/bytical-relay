import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Button, colors, space, type_ } from "../src/theme.tsx";

const FEEDBACK_URL = "https://ws.relay.bytical.ai/a/feedback";

const KINDS = [
  { kind: "review", label: "Review" },
  { kind: "feature", label: "Feature idea" },
  { kind: "update_request", label: "Update request" },
  { kind: "bug", label: "Bug" },
] as const;

export default function Feedback() {
  const router = useRouter();
  const [kind, setKind] = useState<(typeof KINDS)[number]["kind"]>("review");
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  const canSend = message.trim().length > 0 && (kind !== "review" || rating > 0);

  const submit = async () => {
    if (!canSend || state === "sending") return;
    setState("sending");
    try {
      const response = await fetch(FEEDBACK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          rating: kind === "review" ? rating : undefined,
          message: message.trim(),
          contact: contact.trim() || undefined,
          surface: "android",
          version: Constants.expoConfig?.version ?? "dev",
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setState("done");
      setTimeout(() => router.back(), 1600);
    } catch {
      setState("error");
    }
  };

  const chip = (active: boolean) => ({
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: active ? colors.accent : colors.border,
    backgroundColor: active ? colors.accentSoft : "transparent",
  });

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.lg }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={type_.heading}>Tell us anything</Text>
      <Text style={type_.caption}>
        Goes straight to the maintainers — no account, nothing else attached.
      </Text>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {KINDS.map((k) => (
          <Pressable key={k.kind} onPress={() => setKind(k.kind)} style={chip(kind === k.kind)}>
            <Text style={{ ...type_.body, fontSize: 13 }}>{k.label}</Text>
          </Pressable>
        ))}
      </View>

      {kind === "review" ? (
        <View style={{ flexDirection: "row", gap: space.sm }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Pressable key={n} onPress={() => setRating(n)} hitSlop={6}>
              <Text style={{ fontSize: 32, color: n <= rating ? "#E8A13C" : colors.border }}>
                ★
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <TextInput
        value={message}
        onChangeText={setMessage}
        multiline
        maxLength={2000}
        placeholder={
          kind === "bug" ? "What broke? What did you expect?" : "How can Relay be better?"
        }
        placeholderTextColor={colors.dim}
        style={{
          ...type_.body,
          minHeight: 120,
          textAlignVertical: "top",
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 12,
          padding: space.md,
          color: colors.text,
        }}
      />
      <TextInput
        value={contact}
        onChangeText={setContact}
        maxLength={200}
        placeholder="Email or GitHub (optional — only if you want a reply)"
        placeholderTextColor={colors.dim}
        autoCapitalize="none"
        style={{
          ...type_.body,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 12,
          padding: space.md,
          color: colors.text,
        }}
      />

      <Button
        label={
          state === "sending"
            ? "Sending…"
            : state === "done"
              ? "Thank you!"
              : state === "error"
                ? "Failed — tap to retry"
                : "Send feedback"
        }
        disabled={!canSend || state === "sending"}
        onPress={() => void submit()}
      />
    </ScrollView>
  );
}

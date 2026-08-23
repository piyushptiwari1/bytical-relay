import "../src/polyfills.ts";
import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useApp } from "../src/machines.ts";
import { colors } from "../src/theme.tsx";

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const hydrate = useApp((s) => s.hydrate);

  useEffect(() => {
    hydrate()
      .then(() => setReady(true))
      .catch(() => setReady(true));
  }, [hydrate]);

  if (!ready) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
        }}
      >
        <Text style={{ fontSize: 30 }}>⌘</Text>
        <Text style={{ color: colors.dim, fontSize: 13, letterSpacing: 2 }}>RDC</Text>
      </View>
    );
  }
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "600", fontSize: 16 },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Machines" }} />
      <Stack.Screen name="pair" options={{ title: "Pair device", presentation: "modal" }} />
      <Stack.Screen name="machine/[id]" options={{ title: "Machine" }} />
      <Stack.Screen name="project/[machine]/[project]" options={{ title: "Files" }} />
      <Stack.Screen name="git/[machine]/[project]" options={{ title: "Source Control" }} />
      <Stack.Screen name="gitdiff" options={{ title: "Diff", presentation: "modal" }} />
      <Stack.Screen name="agent/[machine]/index" options={{ title: "Agents" }} />
      <Stack.Screen name="agent/[machine]/[session]" options={{ title: "Session" }} />
      <Stack.Screen name="viewer" options={{ title: "File", presentation: "modal" }} />
    </Stack>
  );
}

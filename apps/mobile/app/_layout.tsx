import "../src/polyfills.ts";
import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useApp } from "../src/machines.ts";
import { initCrypto } from "../src/sodium.ts";
import { colors } from "../src/theme.ts";

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const hydrate = useApp((s) => s.hydrate);

  useEffect(() => {
    initCrypto()
      .then(() => hydrate())
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
        }}
      >
        <Text style={{ color: colors.dim }}>starting…</Text>
      </View>
    );
  }
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Machines" }} />
      <Stack.Screen name="pair" options={{ title: "Pair device", presentation: "modal" }} />
      <Stack.Screen name="machine/[id]" options={{ title: "Machine" }} />
      <Stack.Screen name="project/[machine]/[project]" options={{ title: "Files" }} />
      <Stack.Screen name="viewer" options={{ title: "File", presentation: "modal" }} />
    </Stack>
  );
}

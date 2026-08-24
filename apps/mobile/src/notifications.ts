import type { AgentSession } from "@rdc/protocol";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { Platform } from "react-native";

/**
 * Local lock-screen notifications for agent lifecycle (Expo Go supports these;
 * remote killed-app push needs a dev build — controller groundwork in S7b).
 */

let ready = false;
/** session screen currently focused — suppress its own notifications */
let focusedSession: string | null = null;
const lastStatus = new Map<string, string>();

export function setFocusedSession(sessionId: string | null): void {
  focusedSession = sessionId;
}

export async function setupNotifications(): Promise<void> {
  if (ready) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("agent", {
      name: "Agent activity",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 150, 100, 150],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") await Notifications.requestPermissionsAsync();

  // tap → jump straight to that session's screen
  Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as {
      machine?: string;
      session?: string;
    };
    if (data.machine && data.session) {
      router.push(`/agent/${data.machine}/${data.session}`);
    }
  });
  ready = true;
}

/** Feed every agent.status_changed here; fires on meaningful transitions only. */
export function onAgentStatus(machineId: string, session: AgentSession): void {
  const previous = lastStatus.get(session.session_id);
  lastStatus.set(session.session_id, session.status);
  if (previous === session.status) return; // dedupe repeats
  if (focusedSession === session.session_id) return; // user is already looking at it

  const title = session.title?.slice(0, 60) || "Agent session";
  if (session.status === "awaiting_approval") {
    void notify(session.session_id, "🔐 Approval needed", title, machineId);
  } else if (session.status === "idle" && previous === "running") {
    void notify(session.session_id, "✅ Agent finished", title, machineId);
  } else if (session.status === "failed") {
    void notify(session.session_id, "⚠️ Agent failed", title, machineId);
  }
}

/** Approval handled or session opened — clear its notification. */
export async function dismissSessionNotifications(sessionId: string): Promise<void> {
  const shown = await Notifications.getPresentedNotificationsAsync();
  for (const n of shown) {
    if ((n.request.content.data as { session?: string }).session === sessionId) {
      await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  }
}

/** Remote-push token — null in Expo Go on Android (dev build required). */
export async function expoPushTokenOrNull(): Promise<string | null> {
  try {
    const token = await Notifications.getExpoPushTokenAsync();
    return token.data;
  } catch {
    return null;
  }
}

async function notify(
  sessionId: string,
  title: string,
  body: string,
  machineId: string,
): Promise<void> {
  if (!ready) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: { machine: machineId, session: sessionId },
    },
    // channel-aware trigger = immediate delivery on the Android channel
    trigger: Platform.OS === "android" ? { channelId: "agent" } : null,
  });
}

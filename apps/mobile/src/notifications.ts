import type { AgentSession } from "@rdc/protocol";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Local lock-screen notifications for agent lifecycle (Expo Go supports these;
 * remote killed-app push needs a dev build — controller groundwork in S7b).
 */

let ready = false;
/** session screen currently focused — suppress its own notifications */
let focusedSession: string | null = null;
const lastStatus = new Map<string, string>();
const APPROVAL_CATEGORY = "relay_approval";
const REVIEW_ACTION = "review";
const SKIP_ACTION = "skip";
const PENDING_APPROVAL_ACTIONS_KEY = "relay.pending.approval.actions";
const pendingApprovalListeners = new Set<(machineId: string) => void>();

export interface PendingApprovalAction {
  action_id: string;
  machine_id: string;
  session_id: string;
  approval_id: string;
  option_id: string;
}

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
  await Notifications.setNotificationCategoryAsync(
    APPROVAL_CATEGORY,
    [
      { identifier: REVIEW_ACTION, buttonTitle: "Review" },
      {
        identifier: SKIP_ACTION,
        buttonTitle: "Skip",
        options: { isDestructive: true, isAuthenticationRequired: true },
      },
    ],
    { previewPlaceholder: "Relay agent needs a decision" },
  );
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") await Notifications.requestPermissionsAsync();

  // Every response opens the related work; a skip is retained until the encrypted
  // controller connection can acknowledge it.
  Notifications.addNotificationResponseReceivedListener((response) => {
    void handleNotificationResponse(response);
  });
  const lastResponse = await Notifications.getLastNotificationResponseAsync();
  if (lastResponse) {
    await handleNotificationResponse(lastResponse);
    Notifications.clearLastNotificationResponse();
  }
  ready = true;
}

/** Feed every agent.status_changed here; fires on meaningful transitions only. */
export function onAgentStatus(machineId: string, session: AgentSession): void {
  const previous = lastStatus.get(session.session_id);
  lastStatus.set(session.session_id, session.status);
  if (previous === session.status) return; // dedupe repeats
  if (focusedSession === session.session_id) return; // user is already looking at it

  if (session.status === "awaiting_approval") {
    void notify(
      session.session_id,
      "Approval needed",
      "A Relay agent needs a decision.",
      machineId,
    );
  } else if (session.status === "idle" && previous === "running") {
    void notify(
      session.session_id,
      "Agent finished",
      "Open Relay to review the result.",
      machineId,
    );
  } else if (session.status === "failed") {
    void notify(
      session.session_id,
      "Agent needs review",
      "Open Relay to review the result.",
      machineId,
    );
  }
}

function responseData(response: Notifications.NotificationResponse): {
  machine?: string;
  session?: string;
  approval_id?: string;
  skip_option_id?: string;
} {
  return response.notification.request.content.data as {
    machine?: string;
    session?: string;
    approval_id?: string;
    skip_option_id?: string;
  };
}

async function handleNotificationResponse(
  response: Notifications.NotificationResponse,
): Promise<void> {
  const data = responseData(response);
  if (
    response.actionIdentifier === SKIP_ACTION &&
    data.machine &&
    data.session &&
    data.approval_id &&
    data.skip_option_id
  ) {
    await queueApprovalAction({
      action_id: `${response.notification.request.identifier}:${SKIP_ACTION}`,
      machine_id: data.machine,
      session_id: data.session,
      approval_id: data.approval_id,
      option_id: data.skip_option_id,
    });
  }
  if (data.machine && data.session) router.push(`/agent/${data.machine}/${data.session}`);
}

async function readPendingApprovalActions(): Promise<PendingApprovalAction[]> {
  const raw = await SecureStore.getItemAsync(PENDING_APPROVAL_ACTIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is PendingApprovalAction =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as PendingApprovalAction).action_id === "string" &&
            typeof (item as PendingApprovalAction).machine_id === "string" &&
            typeof (item as PendingApprovalAction).approval_id === "string" &&
            typeof (item as PendingApprovalAction).option_id === "string",
        )
      : [];
  } catch {
    return [];
  }
}

async function queueApprovalAction(action: PendingApprovalAction): Promise<void> {
  const pending = await readPendingApprovalActions();
  if (pending.some((item) => item.action_id === action.action_id)) return;
  await SecureStore.setItemAsync(
    PENDING_APPROVAL_ACTIONS_KEY,
    JSON.stringify([...pending, action]),
  );
  for (const listener of pendingApprovalListeners) listener(action.machine_id);
}

/** Notify the connection layer that a lock-screen decision is ready to send. */
export function onPendingApprovalAction(listener: (machineId: string) => void): () => void {
  pendingApprovalListeners.add(listener);
  return () => pendingApprovalListeners.delete(listener);
}

/** Pending lock-screen decisions for one machine, preserved across cold app launches. */
export async function pendingApprovalActions(machineId: string): Promise<PendingApprovalAction[]> {
  return (await readPendingApprovalActions()).filter((action) => action.machine_id === machineId);
}

/** Remove an action only after Relay receives a terminal controller response for it. */
export async function removePendingApprovalAction(actionId: string): Promise<void> {
  const pending = await readPendingApprovalActions();
  await SecureStore.setItemAsync(
    PENDING_APPROVAL_ACTIONS_KEY,
    JSON.stringify(pending.filter((action) => action.action_id !== actionId)),
  );
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

/**
 * Expo Push API sender (https://exp.host/--/api/v2/push/send). Outbound HTTPS
 * only — no infra needed. Delivery to a killed app requires the phone to run a
 * dev build (Expo Go on Android dropped remote push in SDK 53+); tokens simply
 * don't exist until then, so this stays dormant.
 */

export interface PushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
  categoryId?: string;
}

const ENDPOINT = "https://exp.host/--/api/v2/push/send";
const CHUNK = 100;

export async function sendExpoPush(tokens: string[], message: PushMessage): Promise<PushTicket[]> {
  const tickets: PushTicket[] = [];
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK).map((to) => ({
      to,
      title: message.title,
      body: message.body,
      data: message.data ?? {},
      priority: "high",
      channelId: "agent",
      ...(message.categoryId ? { categoryId: message.categoryId } : {}),
    }));
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(chunk),
    });
    const parsed = (await response.json()) as { data?: PushTicket[]; errors?: unknown[] };
    tickets.push(...(parsed.data ?? []));
  }
  return tickets;
}

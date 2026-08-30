import * as SecureStore from "expo-secure-store";

export interface StoredRelayTicket {
  ticket: string;
  not_before: string;
  expires_at: string;
}

export interface StoredRelay {
  url: string;
  tickets: StoredRelayTicket[];
}

function parseStoredRelay(value: unknown): StoredRelay | null {
  if (!value || typeof value !== "object") return null;
  const relay = value as Partial<StoredRelay>;
  if (typeof relay.url !== "string" || !Array.isArray(relay.tickets)) return null;
  const tickets = relay.tickets.filter(
    (ticket): ticket is StoredRelayTicket =>
      typeof ticket === "object" &&
      ticket !== null &&
      typeof (ticket as StoredRelayTicket).ticket === "string" &&
      typeof (ticket as StoredRelayTicket).not_before === "string" &&
      typeof (ticket as StoredRelayTicket).expires_at === "string",
  );
  return tickets.length > 0 ? { url: relay.url, tickets } : null;
}

/** One paired machine — everything needed to reconnect with E2EE. */
export interface StoredMachine {
  machine_id: string;
  name: string;
  device_id: string;
  token: string;
  token_expires_at?: string;
  controller_kx_pub: string;
  kx_pub: string;
  kx_priv: string;
  addrs: string[];
  /** Learned over E2EE; tickets are short-lived and never contain the relay controller secret. */
  relay?: StoredRelay | null;
}

/** A user instruction saved locally while Relay cannot reach its controller. */
export interface PendingAgentPrompt {
  command_id: string;
  machine_id: string;
  session_id: string;
  prompt: string;
  created_at: string;
}

const INDEX_KEY = "rdc.machine.index";
const PENDING_AGENT_PROMPTS_KEY = "relay.pending.agent.prompts";
const entryKey = (id: string) => `rdc.machine.${id.replace(/[^A-Za-z0-9._-]/g, "_")}`;

async function loadIndex(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function loadMachines(): Promise<StoredMachine[]> {
  const ids = await loadIndex();
  const machines: StoredMachine[] = [];
  for (const id of ids) {
    const raw = await SecureStore.getItemAsync(entryKey(id));
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as StoredMachine & { relay?: unknown };
      // A pre-ticket build stored the relay controller secret on the phone. Drop that
      // legacy shape immediately; the next direct controller refresh supplies tickets.
      const relay = parsed.relay === undefined ? undefined : parseStoredRelay(parsed.relay);
      const machine = {
        ...parsed,
        ...(parsed.relay === undefined ? {} : { relay }),
      } as StoredMachine;
      if (parsed.relay !== undefined && relay === null) {
        await SecureStore.setItemAsync(entryKey(id), JSON.stringify(machine));
      }
      machines.push(machine);
    } catch {
      // corrupt entry — skip
    }
  }
  return machines;
}

export async function saveMachine(machine: StoredMachine): Promise<void> {
  await SecureStore.setItemAsync(entryKey(machine.machine_id), JSON.stringify(machine));
  const ids = await loadIndex();
  if (!ids.includes(machine.machine_id)) {
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...ids, machine.machine_id]));
  }
}

export async function removeMachine(machineId: string): Promise<void> {
  await SecureStore.deleteItemAsync(entryKey(machineId));
  const ids = await loadIndex();
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(ids.filter((id) => id !== machineId)));
  const pending = await readPendingAgentPrompts();
  await SecureStore.setItemAsync(
    PENDING_AGENT_PROMPTS_KEY,
    JSON.stringify(pending.filter((item) => item.machine_id !== machineId)),
  );
}

async function readPendingAgentPrompts(): Promise<PendingAgentPrompt[]> {
  const raw = await SecureStore.getItemAsync(PENDING_AGENT_PROMPTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is PendingAgentPrompt =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as PendingAgentPrompt).command_id === "string" &&
            typeof (item as PendingAgentPrompt).machine_id === "string" &&
            typeof (item as PendingAgentPrompt).session_id === "string" &&
            typeof (item as PendingAgentPrompt).prompt === "string" &&
            typeof (item as PendingAgentPrompt).created_at === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export async function pendingAgentPrompts(machineId: string): Promise<PendingAgentPrompt[]> {
  return (await readPendingAgentPrompts())
    .filter((item) => item.machine_id === machineId)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export async function queueAgentPrompt(prompt: PendingAgentPrompt): Promise<void> {
  const pending = await readPendingAgentPrompts();
  if (pending.some((item) => item.command_id === prompt.command_id)) return;
  await SecureStore.setItemAsync(PENDING_AGENT_PROMPTS_KEY, JSON.stringify([...pending, prompt]));
}

export async function removePendingAgentPrompt(commandId: string): Promise<void> {
  const pending = await readPendingAgentPrompts();
  await SecureStore.setItemAsync(
    PENDING_AGENT_PROMPTS_KEY,
    JSON.stringify(pending.filter((item) => item.command_id !== commandId)),
  );
}

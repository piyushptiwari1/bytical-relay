import * as SecureStore from "expo-secure-store";

/** One paired machine — everything needed to reconnect with E2EE. */
export interface StoredMachine {
  machine_id: string;
  name: string;
  device_id: string;
  token: string;
  controller_kx_pub: string;
  kx_pub: string;
  kx_priv: string;
  addrs: string[];
  /** learned from machine.status over E2EE — used when direct addrs fail */
  relay?: { url: string; token: string } | null;
}

const INDEX_KEY = "rdc.machine.index";
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
      machines.push(JSON.parse(raw) as StoredMachine);
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
}

import { err, ok, type Result } from "./result.ts";

/** Deterministic JSON with recursively sorted object keys — canonical form for hashing. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortValue(v);
    return out;
  }
  return value;
}

export function safeJsonParse(text: string): Result<unknown, Error> {
  try {
    return ok(JSON.parse(text));
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

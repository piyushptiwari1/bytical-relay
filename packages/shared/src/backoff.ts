export interface BackoffOptions {
  baseMs: number;
  capMs: number;
}

/**
 * Decorrelated-jitter backoff (AWS architecture blog pattern):
 * next = min(cap, uniform(base, prev * 3)).
 * Pass the previous delay (or 0 for the first attempt).
 */
export function nextDelayMs(
  prevMs: number,
  { baseMs, capMs }: BackoffOptions,
  random: () => number = Math.random,
): number {
  const upper = Math.max(baseMs, prevMs * 3);
  const next = baseMs + random() * (upper - baseMs);
  return Math.min(capMs, Math.max(baseMs, next));
}

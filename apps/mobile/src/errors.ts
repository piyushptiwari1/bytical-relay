/** Every error a human sees must read like a sentence, not errno-speak.
 * Producers keep their diagnostic detail in logs; screens route through here. */
export function humanError(cause: unknown): string {
  const raw = (cause instanceof Error ? cause.message : String(cause)).replace(/^Error:\s*/i, "");
  if (/timeout|timed out/i.test(raw))
    return "Your computer didn't answer in time — it may be waking up or reconnecting. Try again.";
  if (/ENOENT/i.test(raw)) return "A required program isn't installed on the computer.";
  if (
    /websocket|socket hang|network|failed to fetch|ECONN|EAI_AGAIN|not connected|no active connection|connection closed/i.test(
      raw,
    )
  )
    return "Not connected to your computer right now — Relay reconnects automatically.";
  if (/forbidden|denied|scope/i.test(raw))
    return "This phone doesn't have permission for that. Re-pair with supervised access.";
  if (/not.?found/i.test(raw)) return "That item no longer exists on the computer.";
  return raw;
}

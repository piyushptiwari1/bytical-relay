/** "v0.1.0-alpha" | "0.1.0" → [0, 1, 0]; null when the tag has no semver core. */
export function parseVersion(input: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(input.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `candidate` is a strictly newer release than `current`.
 * Prerelease suffixes are ignored on purpose: sideloaded alphas should always
 * be offered the next tag, and we never publish two tags with one core. */
export function isNewerVersion(current: string, candidate: string): boolean {
  const cur = parseVersion(current);
  const next = parseVersion(candidate);
  if (!cur || !next) return false;
  for (let i = 0; i < 3; i++) {
    if ((next[i] as number) !== (cur[i] as number)) return (next[i] as number) > (cur[i] as number);
  }
  return false;
}

export const PROTOCOL_VERSION = 1;

export interface VersionRange {
  min: number;
  max: number;
}

export const SUPPORTED_VERSIONS: VersionRange = { min: 1, max: PROTOCOL_VERSION };

/** Highest version both ranges support, or null when the ranges are disjoint. */
export function negotiateVersion(a: VersionRange, b: VersionRange): number | null {
  const lo = Math.max(a.min, b.min);
  const hi = Math.min(a.max, b.max);
  return lo <= hi ? hi : null;
}

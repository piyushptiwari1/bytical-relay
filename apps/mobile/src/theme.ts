export const colors = {
  bg: "#0d1117",
  card: "#161b22",
  border: "#30363d",
  text: "#e6edf3",
  dim: "#8b949e",
  accent: "#79c0ff",
  ok: "#3fb950",
  warn: "#d29922",
  bad: "#f85149",
} as const;

export const mono = { fontFamily: "monospace" } as const;

export function formatGb(bytes: number): string {
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

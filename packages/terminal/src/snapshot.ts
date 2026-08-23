import type { TerminalLine, TerminalSnapshot } from "@rdc/protocol";
import type { Terminal } from "@xterm/headless";

// standard 16-color palette (VS Code dark-ish) + 256-color cube resolution
const ANSI_16 = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];

function paletteColor(index: number): string {
  if (index < 16) return ANSI_16[index] as string;
  if (index < 232) {
    const value = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(value / 36) % 6] as number;
    const g = steps[Math.floor(value / 6) % 6] as number;
    const b = steps[value % 6] as number;
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  }
  const gray = 8 + (index - 232) * 10;
  return `#${((1 << 24) | (gray << 16) | (gray << 8) | gray).toString(16).slice(1)}`;
}

const rgbColor = (rgb: number): string => `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;

/** Read the headless terminal buffer into styled line spans (newest ≤ maxLines). */
export function snapshotBuffer(term: Terminal, seq: number, maxLines = 500): TerminalSnapshot {
  const buffer = term.buffer.active;
  const total = buffer.length;
  const start = Math.max(0, total - maxLines);
  const lines: TerminalLine[] = [];
  const probe = buffer.getNullCell();

  for (let y = start; y < total; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const spans: TerminalLine["spans"] = [];
    let text = "";
    let fg: string | null = null;
    let bg: string | null = null;
    let bold = false;
    const flush = () => {
      if (text.length > 0) spans.push({ text, fg, bg, bold });
      text = "";
    };
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, probe);
      if (!cell) continue;
      const chars = cell.getChars() || " ";
      const cellFg = cell.isFgDefault()
        ? null
        : cell.isFgRGB()
          ? rgbColor(cell.getFgColor())
          : paletteColor(cell.getFgColor());
      const cellBg = cell.isBgDefault()
        ? null
        : cell.isBgRGB()
          ? rgbColor(cell.getBgColor())
          : paletteColor(cell.getBgColor());
      const cellBold = cell.isBold() !== 0;
      if (cellFg !== fg || cellBg !== bg || cellBold !== bold) {
        flush();
        fg = cellFg;
        bg = cellBg;
        bold = cellBold;
      }
      text += chars;
    }
    flush();
    // drop trailing whitespace-only spans to keep the payload lean
    while (spans.length > 0) {
      const last = spans[spans.length - 1];
      if (last && last.text.trim() === "" && last.bg === null) spans.pop();
      else break;
    }
    lines.push({ spans });
  }
  // trim trailing empty lines
  while (lines.length > 0 && (lines[lines.length - 1]?.spans.length ?? 0) === 0) lines.pop();

  return {
    lines,
    cols: term.cols,
    rows: term.rows,
    cursor_row: buffer.cursorY + buffer.baseY - start,
    seq,
  };
}

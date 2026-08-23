import { describe, expect, test } from "vitest";
import { TerminalManager } from "../src/manager.ts";
import { detectShells } from "../src/shells.ts";

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("TerminalManager on a real PTY", () => {
  test("shell detection finds at least one shell", () => {
    const shells = detectShells();
    expect(shells.length).toBeGreaterThan(0);
  });

  test("create → echo → styled snapshot → detach/reattach state → kill", async () => {
    const manager = new TerminalManager();
    const changed: number[] = [];
    manager.emitter.on("changed", (e) => changed.push(e.seq));

    const shell = process.platform === "win32" ? "cmd" : "login";
    const info = manager.create({ cwd: process.cwd(), shell, cols: 80, rows: 24 });
    expect(info.alive).toBe(true);
    expect(manager.list()).toHaveLength(1);

    await waitFor(() => changed.length > 0); // prompt appeared
    manager.write(info.terminal_id, "echo rdc_terminal_ok\r");
    await waitFor(() => {
      const text = manager
        .snapshot(info.terminal_id)
        .lines.map((l) => l.spans.map((s) => s.text).join(""))
        .join("\n");
      return text.includes("rdc_terminal_ok");
    });

    // snapshot is the full state — a fresh "attach" sees the same history
    const snapshot = manager.snapshot(info.terminal_id);
    const text = snapshot.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n");
    expect(text).toContain("echo rdc_terminal_ok");
    expect(snapshot.cols).toBe(80);
    expect(snapshot.seq).toBeGreaterThan(0);

    expect(manager.resize(info.terminal_id, 100, 30)).toBe(true);
    expect(manager.snapshot(info.terminal_id).cols).toBe(100);

    expect(manager.kill(info.terminal_id)).toBe(true);
    expect(manager.list()).toHaveLength(0);
    await manager.stop();
  });
});

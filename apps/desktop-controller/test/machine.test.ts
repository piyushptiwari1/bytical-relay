import { MachineHealthSchema } from "@rdc/protocol";
import { describe, expect, test, vi } from "vitest";
import { type AwakeStrategy, KeepAwake } from "../src/keep-awake.ts";
import { HealthMonitor } from "../src/machine-health.ts";

describe("HealthMonitor", () => {
  test("quickSnapshot returns schema-valid sane values synchronously", () => {
    const monitor = new HealthMonitor();
    const snap = monitor.latest();
    const parsed = MachineHealthSchema.safeParse(snap);
    expect(parsed.success).toBe(true);
    expect(snap.memory.total_bytes).toBeGreaterThan(0);
    expect(snap.memory.free_bytes).toBeLessThanOrEqual(snap.memory.total_bytes);
    expect(snap.cpu.cores).toBeGreaterThan(0);
    expect(snap.disks.length).toBeGreaterThanOrEqual(1);
    expect(snap.disks[0]?.total_bytes).toBeGreaterThan(0);
  });

  test("sampleOnce fills async probes and caches; cpu load appears on second sample", async () => {
    const monitor = new HealthMonitor({ probeHost: "127.0.0.1", probePort: 1 }); // closed port → offline, fast
    const first = await monitor.sampleOnce();
    expect(MachineHealthSchema.safeParse(first).success).toBe(true);
    const second = await monitor.sampleOnce();
    expect(second.cpu.load_percent).not.toBeNull();
    expect(second.cpu.load_percent).toBeGreaterThanOrEqual(0);
    expect(second.cpu.load_percent).toBeLessThanOrEqual(100);
    expect(monitor.latest().sampled_at).toBe(second.sampled_at); // cached
  }, 15_000);
});

describe("KeepAwake", () => {
  function tracked(): { strategy: AwakeStrategy; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      strategy: {
        supported: true,
        activate: () => calls.push("activate"),
        deactivate: () => calls.push("deactivate"),
      },
    };
  }

  test("enable/disable drives the strategy and reports state", () => {
    const { strategy, calls } = tracked();
    const ka = new KeepAwake(strategy);
    expect(ka.state()).toEqual({ supported: true, enabled: false, until: null });

    const on = ka.enable();
    expect(on.enabled).toBe(true);
    expect(on.until).toBeNull();
    const off = ka.disable();
    expect(off.enabled).toBe(false);
    expect(calls).toEqual(["activate", "deactivate"]);
  });

  test("TTL auto-disables (with periodic re-asserts while enabled)", () => {
    vi.useFakeTimers();
    try {
      const { strategy, calls } = tracked();
      const ka = new KeepAwake(strategy);
      const on = ka.enable(15);
      expect(on.until).not.toBeNull();
      vi.advanceTimersByTime(15 * 60_000 + 1);
      expect(ka.state().enabled).toBe(false);
      expect(calls[0]).toBe("activate");
      expect(calls.at(-1)).toBe("deactivate");
      expect(calls.filter((c) => c === "deactivate")).toHaveLength(1);
      // no re-asserts after disable
      const after = calls.length;
      vi.advanceTimersByTime(10 * 60_000);
      expect(calls.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  test("unsupported strategy is a safe no-op", () => {
    const ka = new KeepAwake({ supported: false, activate() {}, deactivate() {} });
    expect(ka.enable().enabled).toBe(false);
    expect(ka.state().supported).toBe(false);
  });

  test("real platform strategy loads without throwing", () => {
    const ka = new KeepAwake();
    // Windows/macOS always support it; Linux depends on systemd presence
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(ka.supported).toBe(true);
    }
    expect(() => ka.disable()).not.toThrow();
  });

  test("auto-hold keeps the machine awake without flipping manual state", () => {
    const { strategy, calls } = tracked();
    const ka = new KeepAwake(strategy);

    ka.setAutoHold(true); // agents started working
    expect(calls).toEqual(["activate"]);
    expect(ka.state().enabled).toBe(false); // manual toggle untouched

    ka.setAutoHold(true); // idempotent
    expect(calls).toEqual(["activate"]);

    ka.setAutoHold(false); // work finished
    expect(calls).toEqual(["activate", "deactivate"]);

    // manual enable wins over auto release
    ka.enable();
    ka.setAutoHold(true);
    ka.setAutoHold(false);
    expect(ka.state().enabled).toBe(true);
    expect(calls.at(-1)).not.toBe("deactivate"); // still held by manual intent
    ka.disable();
    expect(calls.at(-1)).toBe("deactivate");
  });
});

import { defineConfig } from "vitest/config";

// Real git subprocesses per test — allow slow first-run on cold machines.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});

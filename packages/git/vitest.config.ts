import { defineConfig } from "vitest/config";

// Real git subprocesses per test — allow slow cold runs under full-monorepo parallelism.
export default defineConfig({
  test: {
    retry: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

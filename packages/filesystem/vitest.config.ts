import { defineConfig } from "vitest/config";

// Watcher/E2E tests: one retry absorbs fs-event timing flakes under full-monorepo parallelism.
export default defineConfig({
  test: {
    retry: 1,
    testTimeout: 30_000,
  },
});

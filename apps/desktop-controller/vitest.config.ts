import { defineConfig } from "vitest/config";

// Network/E2E tests: one retry absorbs port/socket timing flakes under full-monorepo parallelism.
export default defineConfig({
  test: {
    retry: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

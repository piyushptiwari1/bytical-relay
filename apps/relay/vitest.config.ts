import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    retry: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

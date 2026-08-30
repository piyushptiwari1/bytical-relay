import { defineConfig } from "vitest/config";

// The scripted agent boots a real child process; CI parallelism can exceed Vitest's 5s default.
export default defineConfig({
  test: {
    retry: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});

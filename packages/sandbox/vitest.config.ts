import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    // Vitest's default worker RPC timeout (5s) can fire in CI when the
    // docker-backed sandbox suite finishes late but the worker's
    // `onTaskUpdate` call is still in-flight. All tests pass but the
    // worker raises an unhandled "Timeout calling onTaskUpdate" error
    // which fails the process. Extend to 30s to absorb CI jitter.
    teardownTimeout: 30_000,
  },
});

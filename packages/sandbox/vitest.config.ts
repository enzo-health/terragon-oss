import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    silent: "passed-only",
    // The docker-backed sandbox suite does real container lifecycle work.
    // Serializing files avoids worker IPC starvation during long runs, and
    // the larger teardown window absorbs slow Docker cleanup on CI hosts.
    teardownTimeout: 120_000,
  },
});

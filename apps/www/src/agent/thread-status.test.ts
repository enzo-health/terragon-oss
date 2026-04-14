import { describe, expect, test } from "vitest";
import { isPreSandboxStatus } from "./thread-status";
import type { ThreadStatus } from "@terragon/shared";

describe("isPreSandboxStatus", () => {
  const preSandbox: ThreadStatus[] = [
    "queued",
    "queued-blocked",
    "queued-sandbox-creation-rate-limit",
    "queued-tasks-concurrency",
    "queued-agent-rate-limit",
    "booting",
  ];

  const postSandboxOrInactive: ThreadStatus[] = [
    "draft",
    "scheduled",
    "working",
    "stopping",
    "checkpointing",
    "working-stopped",
    "working-error",
    "working-done",
    "stopped",
    "complete",
    "error",
  ];

  test.each(preSandbox)("returns true for pre-sandbox status %s", (status) => {
    expect(isPreSandboxStatus(status)).toBe(true);
  });

  test.each(postSandboxOrInactive)(
    "returns false for post-sandbox / inactive status %s",
    (status) => {
      expect(isPreSandboxStatus(status)).toBe(false);
    },
  );
});

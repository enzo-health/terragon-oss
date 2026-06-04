import { describe, expect, it } from "vitest";
import type { ThreadStatus } from "../db/types";
import {
  getFollowUpQueueBlockReason,
  isAgentRunLiveThreadStatus,
  isConcurrencyActiveThreadStatus,
  isPrimaryChatLiveThreadStatus,
  shouldProcessQueuedFollowUpImmediately,
} from "./thread-lifecycle-policy";

const ALL_THREAD_STATUSES = [
  "draft",
  "scheduled",
  "queued",
  "queued-blocked",
  "queued-sandbox-creation-rate-limit",
  "queued-tasks-concurrency",
  "queued-agent-rate-limit",
  "booting",
  "working",
  "stopping",
  "working-stopped",
  "working-error",
  "working-done",
  "checkpointing",
  "stopped",
  "error",
  "complete",
] as const satisfies readonly ThreadStatus[];

describe("thread lifecycle policy", () => {
  it("keeps concurrency-active statuses narrow", () => {
    expect(ALL_THREAD_STATUSES.filter(isConcurrencyActiveThreadStatus)).toEqual(
      ["booting", "working"],
    );
  });

  it("keeps primary chat live statuses aligned with the chat surface", () => {
    expect(ALL_THREAD_STATUSES.filter(isPrimaryChatLiveThreadStatus)).toEqual([
      "queued",
      "queued-blocked",
      "queued-sandbox-creation-rate-limit",
      "queued-tasks-concurrency",
      "queued-agent-rate-limit",
      "booting",
      "working",
      "stopping",
      "working-stopped",
      "working-error",
      "working-done",
      "checkpointing",
    ]);
  });

  it("treats post-turn finishing states as not run-live (composer presents idle)", () => {
    // run-live = primaryChatLive minus the post-turn finishing states, so the
    // composer drops its stop button and "queue when done" placeholder once the
    // agent's turn is over even though the sandbox is still busy (checkpoint).
    expect(ALL_THREAD_STATUSES.filter(isAgentRunLiveThreadStatus)).toEqual([
      "queued",
      "queued-blocked",
      "queued-sandbox-creation-rate-limit",
      "queued-tasks-concurrency",
      "queued-agent-rate-limit",
      "booting",
      "working",
      "stopping",
    ]);
    for (const status of [
      "working-done",
      "working-error",
      "working-stopped",
      "checkpointing",
    ] as const) {
      expect(isPrimaryChatLiveThreadStatus(status)).toBe(true);
      expect(isAgentRunLiveThreadStatus(status)).toBe(false);
    }
  });

  it("only dispatches queued follow-ups immediately from idle terminal states", () => {
    expect(
      ALL_THREAD_STATUSES.filter(shouldProcessQueuedFollowUpImmediately),
    ).toEqual([
      "draft",
      "working-error",
      "working-done",
      "stopped",
      "error",
      "complete",
    ]);
  });

  it("keeps explicit queue block reasons for non-runnable statuses", () => {
    expect(getFollowUpQueueBlockReason("scheduled")).toBe(
      "scheduled_not_runnable",
    );
    expect(getFollowUpQueueBlockReason("queued-agent-rate-limit")).toBe(
      "agent_rate_limited",
    );
    expect(getFollowUpQueueBlockReason("working")).toBeNull();
  });
});

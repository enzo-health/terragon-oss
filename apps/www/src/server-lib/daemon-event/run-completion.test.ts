import { describe, expect, it } from "vitest";
import {
  buildFailedTerminalErrorMetadata,
  buildTerminalLifecyclePolicy,
  resolveTerminalStatusForTransition,
  shouldQueueTerminalCheckpoint,
} from "./run-completion";

describe("run completion policy", () => {
  it("routes terminal statuses to lifecycle events and checkpoint gates", () => {
    expect(
      buildTerminalLifecyclePolicy({
        status: "completed",
        disableGitCheckpointing: false,
      }),
    ).toEqual({
      eventType: "assistant.message_done",
      checkpointReadyStatus: "working-done",
    });
    expect(
      buildTerminalLifecyclePolicy({
        status: "completed",
        disableGitCheckpointing: true,
      }),
    ).toEqual({
      eventType: "assistant.message_done_skip_checkpoint",
      checkpointReadyStatus: null,
    });
    expect(
      buildTerminalLifecyclePolicy({
        status: "failed",
        disableGitCheckpointing: false,
      }),
    ).toEqual({
      eventType: "assistant.message_error",
      checkpointReadyStatus: "working-error",
    });
    expect(
      buildTerminalLifecyclePolicy({
        status: "stopped",
        disableGitCheckpointing: false,
      }),
    ).toEqual({
      eventType: "assistant.message_stop",
      checkpointReadyStatus: null,
    });
  });

  it("treats terminal recovery as a completed transition", () => {
    expect(
      resolveTerminalStatusForTransition({
        resolvedStatus: "failed",
        terminalRecoveryQueued: true,
      }),
    ).toBe("completed");
  });

  it("queues checkpoints only after the terminal status is visible", () => {
    expect(
      shouldQueueTerminalCheckpoint({
        checkpointReadyStatus: "working-done",
        didUpdateStatus: true,
        latestStatus: null,
      }),
    ).toBe(true);
    expect(
      shouldQueueTerminalCheckpoint({
        checkpointReadyStatus: "working-done",
        didUpdateStatus: false,
        latestStatus: "working-done",
      }),
    ).toBe(true);
    expect(
      shouldQueueTerminalCheckpoint({
        checkpointReadyStatus: "working-done",
        didUpdateStatus: false,
        latestStatus: "working",
      }),
    ).toBe(false);
    expect(
      shouldQueueTerminalCheckpoint({
        checkpointReadyStatus: null,
        didUpdateStatus: true,
        latestStatus: "working-done",
      }),
    ).toBe(false);
  });

  it("classifies prompt-too-long terminal failures without leaking raw copy", () => {
    expect(
      buildFailedTerminalErrorMetadata(
        "context length exceeded while processing prompt",
      ),
    ).toEqual({
      errorMessage: "prompt-too-long",
      errorMessageInfo: null,
    });
    expect(buildFailedTerminalErrorMetadata("tool crashed")).toEqual({
      errorMessage: "agent-generic-error",
      errorMessageInfo: "tool crashed",
    });
    expect(buildFailedTerminalErrorMetadata(null)).toEqual({
      errorMessage: "agent-generic-error",
      errorMessageInfo: "",
    });
  });
});

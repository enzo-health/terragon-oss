import { deriveChatFailureThreadErrorType } from "@terragon/shared/runtime/chat-failure";

export type TerminalRunStatus = "completed" | "failed" | "stopped";

export type TerminalLifecycleEventType =
  | "assistant.message_done"
  | "assistant.message_done_skip_checkpoint"
  | "assistant.message_error"
  | "assistant.message_stop";

export type TerminalCheckpointReadyStatus = "working-done" | "working-error";

export type FailedTerminalErrorMetadata = {
  errorMessage: "prompt-too-long" | "agent-generic-error";
  errorMessageInfo: string | null;
};

export function resolveTerminalStatusForTransition(params: {
  resolvedStatus: TerminalRunStatus | "processing";
  terminalRecoveryQueued: boolean;
}): TerminalRunStatus {
  if (params.terminalRecoveryQueued) {
    return "completed";
  }
  if (params.resolvedStatus === "processing") {
    throw new Error("processing runs cannot enter terminal completion");
  }
  return params.resolvedStatus;
}

export function buildTerminalLifecyclePolicy(params: {
  status: TerminalRunStatus;
  disableGitCheckpointing: boolean;
}): {
  eventType: TerminalLifecycleEventType;
  checkpointReadyStatus: TerminalCheckpointReadyStatus | null;
} {
  if (params.status === "stopped") {
    return {
      eventType: "assistant.message_stop",
      checkpointReadyStatus: null,
    };
  }
  if (params.status === "failed") {
    return {
      eventType: "assistant.message_error",
      checkpointReadyStatus: "working-error",
    };
  }
  if (params.disableGitCheckpointing) {
    return {
      eventType: "assistant.message_done_skip_checkpoint",
      checkpointReadyStatus: null,
    };
  }
  return {
    eventType: "assistant.message_done",
    checkpointReadyStatus: "working-done",
  };
}

export function shouldQueueTerminalCheckpoint(params: {
  checkpointReadyStatus: TerminalCheckpointReadyStatus | null;
  didUpdateStatus: boolean;
  latestStatus: string | null | undefined;
}): boolean {
  return (
    params.checkpointReadyStatus !== null &&
    (params.didUpdateStatus ||
      params.latestStatus === params.checkpointReadyStatus)
  );
}

export function buildFailedTerminalErrorMetadata(
  errorMessage: string | null,
): FailedTerminalErrorMetadata {
  const isPromptTooLong =
    deriveChatFailureThreadErrorType(errorMessage) === "prompt-too-long";
  return {
    errorMessage: isPromptTooLong ? "prompt-too-long" : "agent-generic-error",
    errorMessageInfo: isPromptTooLong ? null : (errorMessage ?? ""),
  };
}

import type { ThreadErrorType } from "../db/types";

// Reproduces buildFailedTerminalErrorMetadata's context-window detection
// (apps/www/src/server-lib/daemon-event/run-completion.ts) so the AG-UI
// RUN_ERROR code and the DB-persisted threadChat.errorMessage derive from one
// place. Keep this regex byte-identical to the run-completion one; the
// chat-failure test asserts both produce the same ThreadErrorType.
const CONTEXT_WINDOW_EXHAUSTED_RE =
  /context.?length.?exceeded|context.?window|ran out of room|exceeds the context window|max.*tokens.*exceeded/i;

export function deriveChatFailureThreadErrorType(
  errorMessage: string | null,
): ThreadErrorType {
  if (errorMessage !== null && CONTEXT_WINDOW_EXHAUSTED_RE.test(errorMessage)) {
    return "prompt-too-long";
  }
  return "agent-generic-error";
}

export type ChatErrorEvent = {
  kind: "run-error";
  threadErrorType: ThreadErrorType;
  message: string;
  // Stamped by P4-B's runtime onError wire-contract change; optional here so
  // this module is a no-op until that single edit lands.
  clientSubmissionId?: string;
  runId?: string;
};

export function deriveChatFailure(params: {
  errorMessage: string | null;
  clientSubmissionId?: string;
  runId?: string;
}): ChatErrorEvent {
  return {
    kind: "run-error",
    threadErrorType: deriveChatFailureThreadErrorType(params.errorMessage),
    message: params.errorMessage ?? "Run failed",
    ...(params.clientSubmissionId
      ? { clientSubmissionId: params.clientSubmissionId }
      : {}),
    ...(params.runId ? { runId: params.runId } : {}),
  };
}

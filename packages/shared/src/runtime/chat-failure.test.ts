import { describe, expect, it } from "vitest";
import {
  deriveChatFailure,
  deriveChatFailureThreadErrorType,
} from "./chat-failure";

describe("deriveChatFailureThreadErrorType", () => {
  it("maps context-window exhaustion to prompt-too-long", () => {
    expect(deriveChatFailureThreadErrorType("context length exceeded")).toBe(
      "prompt-too-long",
    );
    expect(deriveChatFailureThreadErrorType("exceeds the context window")).toBe(
      "prompt-too-long",
    );
  });
  it("maps any other failure (and null) to agent-generic-error", () => {
    expect(deriveChatFailureThreadErrorType("Codex error: boom")).toBe(
      "agent-generic-error",
    );
    expect(deriveChatFailureThreadErrorType(null)).toBe("agent-generic-error");
  });
});

describe("deriveChatFailure", () => {
  it("defaults message to 'Run failed' on null and omits optional ids", () => {
    const e = deriveChatFailure({ errorMessage: null });
    expect(e).toEqual({
      kind: "run-error",
      threadErrorType: "agent-generic-error",
      message: "Run failed",
    });
  });
  it("carries optional clientSubmissionId/runId when provided", () => {
    const e = deriveChatFailure({
      errorMessage: "context length exceeded",
      clientSubmissionId: "cs-1",
      runId: "r-1",
    });
    expect(e).toEqual({
      kind: "run-error",
      threadErrorType: "prompt-too-long",
      message: "context length exceeded",
      clientSubmissionId: "cs-1",
      runId: "r-1",
    });
  });
});

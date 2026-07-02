import type { ThreadErrorType } from "@terragon/shared";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatError, isSandboxErrorType } from "./chat-error";

describe("isSandboxErrorType", () => {
  it("matches the sandbox boot/connect error types", () => {
    expect(isSandboxErrorType("sandbox-not-found")).toBe(true);
    expect(isSandboxErrorType("sandbox-creation-failed")).toBe(true);
    expect(isSandboxErrorType("sandbox-resume-failed")).toBe(true);
  });

  it("returns false for non-sandbox error types and empty input", () => {
    expect(isSandboxErrorType("agent-generic-error")).toBe(false);
    expect(isSandboxErrorType("")).toBe(false);
    expect(isSandboxErrorType(null)).toBe(false);
    expect(isSandboxErrorType(undefined)).toBe(false);
  });
});

describe("ChatError sandbox error rendering", () => {
  const noopRetry = async () => {};

  it("renders a friendly message + actionable retry for sandbox-not-found", () => {
    const html = renderToStaticMarkup(
      <ChatError
        status="error"
        errorType="sandbox-not-found"
        errorInfo=""
        handleRetry={noopRetry}
        isReadOnly={false}
      />,
    );
    // Friendly header replaces the old raw "Sandbox not found".
    expect(html).toContain("Couldn&#x27;t connect to sandbox");
    expect(html).not.toContain("<pre");
    // Retry button should be present (not hidden for sandbox errors).
    expect(html).toContain("Retry");
  });

  it("renders a status-page link for sandbox-creation-failed", () => {
    const html = renderToStaticMarkup(
      <ChatError
        status="error"
        errorType="sandbox-creation-failed"
        errorInfo="Provider returned 503"
        handleRetry={noopRetry}
        isReadOnly={false}
      />,
    );
    expect(html).toContain("Couldn&#x27;t start sandbox");
    expect(html).toContain("status page");
    // Upstream details still available inside a <details> disclosure.
    expect(html).toContain("Provider returned 503");
  });

  it("shows retry for unknown-error but with a friendlier header", () => {
    const html = renderToStaticMarkup(
      <ChatError
        status="error"
        errorType="unknown-error"
        errorInfo="boom"
        handleRetry={noopRetry}
        isReadOnly={false}
      />,
    );
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("Unknown Error");
    // unknown-error is now retryable.
    expect(html).toContain("Retry");
  });

  it("hides retry for prompt-too-long (unrecoverable without user action)", () => {
    const html = renderToStaticMarkup(
      <ChatError
        status="error"
        errorType="prompt-too-long"
        errorInfo=""
        handleRetry={noopRetry}
        isReadOnly={false}
      />,
    );
    expect(html).toContain("Context window full");
    expect(html).not.toContain('title="Retry"');
  });
});

// Every ThreadErrorType must render its own specific header, never the generic
// UnknownChatError fallback. Typing the header map as `Record<ThreadErrorType,
// _>` makes adding a union member a compile error here — the test-side twin of
// the `never` exhaustiveness check in chat-error.tsx. Substrings avoid rendered
// apostrophe escaping (e.g. "Couldn't" -> "Couldn&#x27;t").
describe("ChatError renders a specific header for every ThreadErrorType", () => {
  const noopRetry = async () => {};

  const HEADER_BY_ERROR_TYPE: Record<ThreadErrorType, string> = {
    "request-timeout": "Request timed out",
    "no-user-message": "No user message found",
    "unknown-error": "Something went wrong",
    "sandbox-not-found": "connect to sandbox",
    "sandbox-creation-failed": "start sandbox",
    "sandbox-resume-failed": "resume sandbox",
    "missing-gemini-credentials": "Gemini API key required",
    "missing-amp-credentials": "Amp API key required",
    "chatgpt-sub-required": "ChatGPT account required",
    "invalid-codex-credentials": "OpenAI credentials expired",
    "invalid-claude-credentials": "Claude credentials expired",
    "agent-not-responding": "Agent did not respond",
    "agent-generic-error": "Agent exited with an error",
    "git-checkpoint-diff-failed": "Git checkpoint failed",
    "git-checkpoint-push-failed": "Git push failed",
    "setup-script-failed": "terragon-setup.sh failed",
    "prompt-too-long": "Context window full",
    "queue-limit-exceeded": "Task queue limit reached",
  };

  for (const [errorType, header] of Object.entries(HEADER_BY_ERROR_TYPE)) {
    it(`renders the specific header for ${errorType}`, () => {
      const html = renderToStaticMarkup(
        <ChatError
          status="error"
          errorType={errorType}
          errorInfo="detail"
          handleRetry={noopRetry}
          isReadOnly={false}
        />,
      );
      expect(html).toContain(header);
      // Never the generic fallback headers from UnknownChatError.
      expect(html).not.toContain("An error occurred");
      expect(html).not.toContain("An unexpected error occurred");
    });
  }
});

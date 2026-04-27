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

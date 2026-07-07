import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractRuntimeErrorPayload,
  isTransientRunLifecycleError,
} from "./runtime-error-classification";

describe("isTransientRunLifecycleError", () => {
  it("matches the RUN_STARTED-while-active race (the reported error)", () => {
    expect(
      isTransientRunLifecycleError(
        "Cannot send 'RUN_STARTED' while a run is still active. The previous run must be finished with 'RUN_FINISHED' before starting a new run.",
      ),
    ).toBe(true);
  });

  it("matches the event-after-RUN_FINISHED tail race", () => {
    expect(
      isTransientRunLifecycleError(
        "Cannot send event type 'TEXT_MESSAGE_START': The run has already finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'.",
      ),
    ).toBe(true);
  });

  it("accepts an Error object", () => {
    expect(
      isTransientRunLifecycleError(
        new Error("Cannot send 'RUN_STARTED' while a run is still active."),
      ),
    ).toBe(true);
  });

  it("does NOT match real failures", () => {
    expect(isTransientRunLifecycleError("Network request failed")).toBe(false);
    expect(isTransientRunLifecycleError("Unauthorized")).toBe(false);
    expect(
      isTransientRunLifecycleError("First event must be 'RUN_STARTED'"),
    ).toBe(false);
    expect(isTransientRunLifecycleError("Tool execution failed: ENOENT")).toBe(
      false,
    );
  });

  it("handles null/undefined/empty safely", () => {
    expect(isTransientRunLifecycleError(null)).toBe(false);
    expect(isTransientRunLifecycleError(undefined)).toBe(false);
    expect(isTransientRunLifecycleError("")).toBe(false);
    expect(isTransientRunLifecycleError(new Error(""))).toBe(false);
  });
});

describe("verifyEvents throw-string pinning (@ag-ui/client@0.0.52)", () => {
  const installedClientSource = (() => {
    const require = createRequire(import.meta.url);
    return readFileSync(require.resolve("@ag-ui/client"), "utf8");
  })();

  const PINNED_LIFECYCLE_STRINGS = [
    "Cannot send 'RUN_STARTED' while a run is still active",
    "The run has already finished with 'RUN_FINISHED'",
  ] as const;

  for (const phrase of PINNED_LIFECYCLE_STRINGS) {
    it(`still ships the lifecycle phrase: "${phrase}"`, () => {
      expect(installedClientSource).toContain(phrase);
    });

    it(`suppresses the lifecycle phrase: "${phrase}"`, () => {
      expect(isTransientRunLifecycleError(phrase)).toBe(true);
    });
  }
});

describe("extractRuntimeErrorPayload typed-code priority", () => {
  it("prefers the captured typed RUN_ERROR code over the defensive cast", () => {
    const error = Object.assign(new Error("boom"), {
      code: "unknown-error",
    });
    const payload = extractRuntimeErrorPayload(
      error,
      "invalid-claude-credentials",
    );
    expect(payload).toEqual({
      kind: "run-failure",
      code: "invalid-claude-credentials",
      clientSubmissionId: null,
      info: "boom",
    });
  });

  it("falls back to the defensive `.code` cast when no typed code is captured", () => {
    const error = Object.assign(new Error("boom"), {
      code: "sandbox-not-found",
    });
    const payload = extractRuntimeErrorPayload(error, null);
    expect(payload).toEqual({
      kind: "run-failure",
      code: "sandbox-not-found",
      clientSubmissionId: null,
      info: "boom",
    });
  });

  it("ignores a captured code that is not a ThreadErrorType and falls through", () => {
    const error = new Error("network down");
    const payload = extractRuntimeErrorPayload(
      error,
      "some-transport-category",
    );
    expect(payload).toEqual({
      kind: "transport",
      clientSubmissionId: null,
      info: "network down",
    });
  });

  it("still classifies lock-held before reading any code", () => {
    const error = new Error("Run already in progress");
    const payload = extractRuntimeErrorPayload(error, "unknown-error");
    expect(payload).toEqual({ kind: "lock-held", clientSubmissionId: null });
  });

  it("suppresses transient lifecycle races regardless of captured code", () => {
    const error = new Error(
      "Cannot send 'RUN_STARTED' while a run is still active.",
    );
    expect(extractRuntimeErrorPayload(error, "unknown-error")).toEqual({
      kind: "transient-lifecycle",
    });
  });
});

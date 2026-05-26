import { describe, expect, it } from "vitest";
import { isTransientRunLifecycleError } from "./runtime-error-classification";

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

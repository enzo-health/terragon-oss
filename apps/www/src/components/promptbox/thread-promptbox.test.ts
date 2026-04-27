import { describe, expect, it } from "vitest";
import {
  getBootingPlaceholder,
  getThreadPromptPlaceholder,
  WORKING_QUEUE_PLACEHOLDER,
} from "./thread-promptbox";

describe("getBootingPlaceholder", () => {
  it("maps each sandbox boot stage to a specific prompt placeholder", () => {
    expect(getBootingPlaceholder("provisioning", "booting")).toBe(
      "Provisioning machine...",
    );
    expect(getBootingPlaceholder("provisioning-done", "booting")).toBe(
      "Provisioning machine...",
    );
    expect(getBootingPlaceholder("cloning-repo", "booting")).toBe(
      "Cloning repository...",
    );
    expect(getBootingPlaceholder("installing-agent", "booting")).toBe(
      "Installing agent...",
    );
    expect(getBootingPlaceholder("running-setup-script", "booting")).toBe(
      "Configuring environment...",
    );
    expect(getBootingPlaceholder("booting-done", "booting")).toBe(
      "Waiting for assistant to start...",
    );
  });

  it("falls back to status-aware labels when substatus is missing", () => {
    expect(getBootingPlaceholder(null, "booting")).toBe(
      "Waiting for assistant to start...",
    );
    expect(getBootingPlaceholder(undefined, "queued")).toBe(
      "Waiting in queue...",
    );
    expect(getBootingPlaceholder(undefined, "queued-blocked")).toBe(
      "Waiting in queue...",
    );
    expect(getBootingPlaceholder(undefined, null)).toBe(
      "Sandbox is provisioning...",
    );
  });
});

describe("getThreadPromptPlaceholder", () => {
  it("does not keep provisioning copy once a run has started", () => {
    expect(
      getThreadPromptPlaceholder({
        bootingSubstatus: "provisioning",
        status: "booting",
        sandboxId: null,
        runStarted: true,
      }),
    ).toBe(WORKING_QUEUE_PLACEHOLDER);
  });

  it("uses queue/work copy consistently for queued, booting-after-start, and working statuses", () => {
    expect(
      getThreadPromptPlaceholder({
        bootingSubstatus: null,
        status: "queued",
        sandboxId: "sandbox-1",
        runStarted: false,
      }),
    ).toBe(WORKING_QUEUE_PLACEHOLDER);
    expect(
      getThreadPromptPlaceholder({
        bootingSubstatus: "running-setup-script",
        status: "booting",
        sandboxId: null,
        runStarted: true,
      }),
    ).toBe(WORKING_QUEUE_PLACEHOLDER);
    expect(
      getThreadPromptPlaceholder({
        bootingSubstatus: null,
        status: "working",
        sandboxId: "sandbox-1",
        runStarted: true,
      }),
    ).toBe(WORKING_QUEUE_PLACEHOLDER);
  });
});

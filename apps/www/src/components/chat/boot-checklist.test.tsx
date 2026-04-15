import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BootChecklist } from "./boot-checklist";
import type { ThreadMetaSnapshot } from "./meta-chips/use-thread-meta-events";

// ---------------------------------------------------------------------------
// Mock useThreadMetaEvents so the component doesn't need realtime/WebSocket.
// ---------------------------------------------------------------------------

const mockSnapshot: ThreadMetaSnapshot = {
  tokenUsage: null,
  rateLimits: null,
  modelReroute: null,
  mcpServerStatus: {},
  bootSteps: [],
  installProgress: null,
};

vi.mock("./meta-chips/use-thread-meta-events", () => ({
  useThreadMetaEvents: (_threadId: string) => ({
    snapshot: mockSnapshot,
    dispatch: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function render(
  currentSubstatus: React.ComponentProps<
    typeof BootChecklist
  >["currentSubstatus"],
  snapshotOverride?: Partial<ThreadMetaSnapshot>,
) {
  // Update the shared mock object so the mock factory picks it up.
  Object.assign(mockSnapshot, {
    tokenUsage: null,
    rateLimits: null,
    modelReroute: null,
    mcpServerStatus: {},
    bootSteps: [],
    installProgress: null,
    ...snapshotOverride,
  });

  return renderToStaticMarkup(
    <BootChecklist
      threadId="test-thread"
      currentSubstatus={currentSubstatus}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BootChecklist", () => {
  it("renders all 5 step labels", () => {
    const html = render("provisioning");
    expect(html).toContain("Provisioning machine");
    expect(html).toContain("Cloning repository");
    expect(html).toContain("Installing agent");
    expect(html).toContain("Running terragon-setup.sh");
    expect(html).toContain("Waiting for assistant to start");
  });

  it("first step in-progress when currentSubstatus=provisioning, no meta events", () => {
    const html = render("provisioning");
    // Spinner (Loader2) should be present for in-progress
    expect(html).toContain("animate-spin");
    // List should have role=list
    expect(html).toContain('role="list"');
  });

  it("provisioning-done maps to provisioning step as in-progress", () => {
    const html = render("provisioning-done");
    // Step 0 (provisioning) is still active
    expect(html).toContain("animate-spin");
    // Step 1+ should be pending (opacity-40)
    expect(html).toContain("opacity-40");
  });

  it("null currentSubstatus shows first step as in-progress", () => {
    const html = render(null);
    expect(html).toContain("animate-spin");
  });

  it("mid-boot: cloning-repo active — previous step appears completed-style", () => {
    const html = render("cloning-repo");
    // Should still have the spinner for the active step
    expect(html).toContain("animate-spin");
    // Step 0 icon should be a check (completed)
    // Step 1 should have the spinner
    // We can't directly check rendered icon state without JSDOM,
    // but we verify structure
    expect(html).toContain("Cloning repository");
  });

  it("installing-agent shows no progress bar when installProgress is null", () => {
    const html = render("installing-agent");
    // Progress bar uses ━ character — should not be present
    expect(html).not.toContain("━");
  });

  it("installing-agent shows progress bar when installProgress is set", () => {
    const html = render("installing-agent", {
      bootSteps: [
        {
          substatus: "provisioning",
          startedAt: "2026-01-01T10:00:00.000Z",
          completedAt: "2026-01-01T10:00:02.000Z",
          durationMs: 2000,
        },
        {
          substatus: "cloning-repo",
          startedAt: "2026-01-01T10:00:02.000Z",
          completedAt: "2026-01-01T10:00:20.000Z",
          durationMs: 18000,
        },
        {
          substatus: "installing-agent",
          startedAt: "2026-01-01T10:00:20.000Z",
        },
      ],
      installProgress: {
        resolved: 40,
        reused: 10,
        downloaded: 30,
        added: 0,
        total: 200,
        currentPackage: "@tanstack/react-query",
        elapsedMs: 3000,
      },
    });

    // Progress bar characters
    expect(html).toContain("━");
    expect(html).toContain("40/200");
    expect(html).toContain("@tanstack/react-query");
  });

  it("shows duration for completed steps from meta events", () => {
    const html = render("cloning-repo", {
      bootSteps: [
        {
          substatus: "provisioning",
          startedAt: "2026-01-01T10:00:00.000Z",
          completedAt: "2026-01-01T10:00:02.000Z",
          durationMs: 2000,
        },
        {
          substatus: "cloning-repo",
          startedAt: "2026-01-01T10:00:02.000Z",
        },
      ],
    });

    // Duration shown for provisioning step (2000ms = 2.0s)
    expect(html).toContain("2.0s");
  });

  it("shows sub-second durations in ms", () => {
    const html = render("cloning-repo", {
      bootSteps: [
        {
          substatus: "provisioning",
          startedAt: "2026-01-01T10:00:00.000Z",
          completedAt: "2026-01-01T10:00:00.800Z",
          durationMs: 800,
        },
        {
          substatus: "cloning-repo",
          startedAt: "2026-01-01T10:00:00.800Z",
        },
      ],
    });

    expect(html).toContain("800ms");
  });

  it("all steps completed when booting-done active (last step)", () => {
    const html = render("booting-done", {
      bootSteps: [
        {
          substatus: "provisioning",
          startedAt: "2026-01-01T10:00:00.000Z",
          completedAt: "2026-01-01T10:00:02.000Z",
          durationMs: 2000,
        },
        {
          substatus: "cloning-repo",
          startedAt: "2026-01-01T10:00:02.000Z",
          completedAt: "2026-01-01T10:00:20.000Z",
          durationMs: 18000,
        },
        {
          substatus: "installing-agent",
          startedAt: "2026-01-01T10:00:20.000Z",
          completedAt: "2026-01-01T10:01:00.000Z",
          durationMs: 40000,
        },
        {
          substatus: "running-setup-script",
          startedAt: "2026-01-01T10:01:00.000Z",
          completedAt: "2026-01-01T10:01:05.000Z",
          durationMs: 5000,
        },
        {
          substatus: "booting-done",
          startedAt: "2026-01-01T10:01:05.000Z",
        },
      ],
    });

    // Should have checkmarks for all prior steps (Check icon SVG is present)
    // and spinner for booting-done
    expect(html).toContain("animate-spin");
    // Multiple duration badges
    expect(html).toContain("2.0s");
    expect(html).toContain("18.0s");
    expect(html).toContain("40.0s");
    expect(html).toContain("5.0s");
  });

  it("has accessible role and aria-label attributes", () => {
    const html = render("provisioning");
    expect(html).toContain('role="list"');
    expect(html).toContain('aria-label="Boot progress"');
  });
});

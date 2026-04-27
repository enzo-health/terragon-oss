import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BootChecklist, formatDuration } from "./boot-checklist";
import type { ThreadMetaSnapshot } from "./meta-chips/use-thread-meta-events";
import type { BootingSubstatus } from "@terragon/shared/runtime/thread-meta-event";

const mockSnapshot: ThreadMetaSnapshot = {
  tokenUsage: null,
  rateLimits: null,
  modelReroute: null,
  mcpServerStatus: {},
  bootSteps: [],
  installProgress: null,
};

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
      currentSubstatus={currentSubstatus}
      metaSnapshot={mockSnapshot}
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
    expect(html).toContain("Configuring environment");
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

  it("active step icon uses text-foreground (not text-muted-foreground)", () => {
    const html = render("cloning-repo");
    // Active icon span should contain text-foreground
    expect(html).toContain("text-foreground");
  });

  it("currentPackage has title attribute for full-name tooltip", () => {
    const longPackageName = "@very-long-scope/some-deeply-nested-package-name";
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
        resolved: 10,
        reused: 0,
        downloaded: 10,
        added: 0,
        total: 100,
        currentPackage: longPackageName,
        elapsedMs: 1000,
      },
    });

    expect(html).toContain(`title="${longPackageName}"`);
  });

  // ---------------------------------------------------------------------------
  // Indeterminate progress bar (total = undefined)
  // ---------------------------------------------------------------------------

  it("renders progress bar in indeterminate mode when total is undefined", () => {
    const html = render("installing-agent", {
      installProgress: {
        resolved: 15,
        reused: 0,
        downloaded: 15,
        added: 0,
        // total intentionally omitted — indeterminate
        currentPackage: "typescript",
        elapsedMs: 1200,
      },
    });

    // Bar characters must still be present
    expect(html).toContain("━");
    // Determinate "resolved/total" count must NOT appear
    expect(html).not.toContain("40/200");
    // Package name must still appear
    expect(html).toContain("typescript");
  });

  it("renders indeterminate bar with '15 resolved' label instead of fraction", () => {
    const html = render("installing-agent", {
      installProgress: {
        resolved: 15,
        reused: 0,
        downloaded: 15,
        added: 0,
        elapsedMs: 1200,
      },
    });

    // The indeterminate path uses "{resolved} resolved" aria-label text
    expect(html).toContain("15 resolved");
    // No slash-separated fraction
    expect(html).not.toContain("15/");
  });

  // ---------------------------------------------------------------------------
  // Unknown substatus fallback
  // ---------------------------------------------------------------------------

  it("provisioning-done from meta events still renders provisioning as active (regression)", () => {
    // Regression: before the normalizeBootSubstatus fix in the meta-events
    // path, a bootSteps entry with substatus="provisioning-done" would send
    // findIndex → -1 → every step pending (blank UI). After the fix, it
    // normalizes to "provisioning" and renders step 0 as in-progress.
    const html = render("provisioning", {
      bootSteps: [
        {
          substatus: "provisioning-done",
          startedAt: new Date().toISOString(),
        },
      ],
    });
    // First step (Provisioning machine) rendered with spinner.
    expect(html).toContain("Provisioning machine");
    expect(html).toContain("animate-spin");
    // No steps are silently all-pending — at least one step must be marked
    // active (has a spinner). This is the guard against the regression.
  });

  it("shows first step as active and does not crash for an unknown future substatus", () => {
    // The component's findIndex returns -1 for an unknown substatus; the
    // currentStepIndex helper maps -1 → 0.  Cast is required because the type
    // union won't include this value at compile time.
    const html = render("future-unknown-step" as BootingSubstatus);

    // Spinner present — first step is treated as in-progress
    expect(html).toContain("animate-spin");
    // First step label must be rendered
    expect(html).toContain("Provisioning machine");
    // No crash — HTML was produced
    expect(html.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatDuration unit tests
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("sub-second returns ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("1s–59.9s returns X.Xs", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(2000)).toBe("2.0s");
    expect(formatDuration(59_999)).toBe("60.0s");
  });

  it("60s+ returns Mm Ss", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(120_000)).toBe("2m 0s");
    expect(formatDuration(3_661_000)).toBe("61m 1s");
  });
});

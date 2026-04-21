import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { classifyDeliveryLoopFooter, WorkingMessage } from "./chat-messages";

describe("classifyDeliveryLoopFooter", () => {
  it("returns active for null/undefined so non-delivery-loop threads are unaffected", () => {
    expect(classifyDeliveryLoopFooter(null)).toEqual({ kind: "active" });
    expect(classifyDeliveryLoopFooter(undefined)).toEqual({ kind: "active" });
  });

  it("classifies active delivery-loop states as active", () => {
    for (const state of [
      "planning",
      "implementing",
      "review_gate",
      "ci_gate",
      "babysitting",
    ] as const) {
      expect(classifyDeliveryLoopFooter(state)).toEqual({ kind: "active" });
    }
  });

  it("maps awaiting_pr_link to 'Waiting for PR merge' passive footer", () => {
    expect(classifyDeliveryLoopFooter("awaiting_pr_link")).toEqual({
      kind: "passive",
      message: "Waiting for PR merge",
    });
  });

  it("maps blocked (awaiting_manual_fix / awaiting_operator_action) to 'Waiting for your input'", () => {
    // Both awaiting_manual_fix and awaiting_operator_action collapse to
    // `blocked` at the API boundary (see stateToDeliveryLoopState).
    expect(classifyDeliveryLoopFooter("blocked")).toEqual({
      kind: "passive",
      message: "Waiting for your input",
    });
  });

  it("hides the footer for terminal states", () => {
    for (const state of [
      "done",
      "stopped",
      "terminated_pr_closed",
      "terminated_pr_merged",
    ] as const) {
      expect(classifyDeliveryLoopFooter(state)).toEqual({ kind: "hidden" });
    }
  });
});

describe("WorkingMessage passive-wait rendering", () => {
  it("renders the passive-wait message without the 'esc to interrupt' hint", () => {
    const html = renderToStaticMarkup(
      <WorkingMessage
        agent="claudeCode"
        status="working"
        reattemptQueueAt={null}
        passiveWait={{ message: "Waiting for PR merge" }}
      />,
    );
    expect(html).toContain("Waiting for PR merge");
    expect(html).not.toContain("esc to interrupt");
    expect(html).not.toContain("Assistant is working");
    // Passive footer should not render the typing-dots animation.
    expect(html).not.toContain("typing-dots");
  });

  it("falls through to the default 'Assistant is working' footer when passiveWait is null", () => {
    const html = renderToStaticMarkup(
      <WorkingMessage
        agent="claudeCode"
        status="working"
        reattemptQueueAt={null}
      />,
    );
    expect(html).toContain("Assistant is working");
    expect(html).toContain("typing-dots");
  });
});

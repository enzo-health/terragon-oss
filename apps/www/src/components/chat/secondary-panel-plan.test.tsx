import type { PlanArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PlanArtifactRenderer } from "./secondary-panel-plan";

vi.mock("@/components/ai-elements/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

describe("PlanArtifactRenderer", () => {
  it("renders canonical ExitPlanMode artifacts without delivery-loop approval actions", () => {
    const descriptor: PlanArtifactDescriptor = {
      id: "artifact:plan:exit-plan-1",
      kind: "plan",
      title: "Plan",
      status: "ready",
      part: {
        type: "tool",
        id: "exit-plan-1",
        agent: "claudeCode",
        name: "ExitPlanMode",
        parameters: { plan: "## Plan\n\nShip via canonical artifacts." },
        status: "completed",
        result: "done",
        parts: [],
      },
      origin: {
        type: "plan-tool",
        toolCallId: "exit-plan-1",
        fingerprint: "fingerprint-1",
      },
    };

    const html = renderToStaticMarkup(
      <PlanArtifactRenderer
        descriptor={descriptor}
        threadId="thread-1"
        threadChatId="chat-1"
      />,
    );

    expect(html).toContain("Ship via canonical artifacts.");
    expect(html).not.toContain("Approve");
  });

  it("keeps historical proposed_plan artifacts readable", () => {
    const descriptor: PlanArtifactDescriptor = {
      id: "artifact:plan:text:legacy",
      kind: "plan",
      title: "Implementation Plan",
      status: "ready",
      part: {
        type: "plan",
        planText: "# Implementation Plan\n\n- Legacy task one",
        title: "Implementation Plan",
      },
      origin: {
        type: "tool-part",
        toolCallId: "plan-text-legacy",
        toolCallName: "proposed_plan",
        toolCallPath: [],
        artifactOrdinal: 0,
        partType: "plan",
        fingerprint: "legacy",
      },
    };

    const html = renderToStaticMarkup(
      <PlanArtifactRenderer descriptor={descriptor} />,
    );

    expect(html).toContain("Implementation Plan");
    expect(html).toContain("Legacy task one");
  });
});

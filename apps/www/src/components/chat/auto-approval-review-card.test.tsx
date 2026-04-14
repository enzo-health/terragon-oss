import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AutoApprovalReviewCard } from "./auto-approval-review-card";
import type { DBAutoApprovalReviewPart } from "@terragon/shared";

function makePart(
  overrides: Partial<DBAutoApprovalReviewPart> = {},
): DBAutoApprovalReviewPart {
  return {
    type: "auto-approval-review",
    reviewId: "review-001",
    targetItemId: "item-001",
    riskLevel: "low",
    action: "Read file src/index.ts",
    status: "pending",
    ...overrides,
  };
}

describe("AutoApprovalReviewCard", () => {
  it("renders pending decision badge", () => {
    const html = renderToStaticMarkup(
      <AutoApprovalReviewCard part={makePart({ status: "pending" })} />,
    );
    expect(html).toContain('data-decision="pending"');
    expect(html).toContain("Pending");
  });

  it("renders approved decision badge", () => {
    const html = renderToStaticMarkup(
      <AutoApprovalReviewCard part={makePart({ status: "approved" })} />,
    );
    expect(html).toContain('data-decision="approved"');
    expect(html).toContain("Approved");
  });

  it("renders denied decision badge", () => {
    const html = renderToStaticMarkup(
      <AutoApprovalReviewCard part={makePart({ status: "denied" })} />,
    );
    expect(html).toContain('data-decision="denied"');
    expect(html).toContain("Denied");
  });

  it("renders low risk pill", () => {
    const html = renderToStaticMarkup(
      <AutoApprovalReviewCard part={makePart({ riskLevel: "low" })} />,
    );
    expect(html).toContain('data-risk="low"');
    expect(html).toContain("low risk");
  });

  it("renders medium risk pill", () => {
    const html = renderToStaticMarkup(
      <AutoApprovalReviewCard part={makePart({ riskLevel: "medium" })} />,
    );
    expect(html).toContain('data-risk="medium"');
  });

  it("renders high risk pill", () => {
    const html = renderToStaticMarkup(
      <AutoApprovalReviewCard part={makePart({ riskLevel: "high" })} />,
    );
    expect(html).toContain('data-risk="high"');
  });

  it("renders action description", () => {
    const html = renderToStaticMarkup(
      <AutoApprovalReviewCard
        part={makePart({ action: "Execute: rm -rf /tmp/stale" })}
      />,
    );
    expect(html).toContain("Execute: rm -rf /tmp/stale");
  });

  it("renders rationale when provided", () => {
    const html = renderToStaticMarkup(
      <AutoApprovalReviewCard
        part={makePart({ rationale: "This action is safe within scope" })}
      />,
    );
    expect(html).toContain("This action is safe within scope");
  });

  it("does not render rationale section when absent", () => {
    const part = makePart();
    delete part.rationale;
    const html = renderToStaticMarkup(<AutoApprovalReviewCard part={part} />);
    expect(html).not.toContain("within scope");
  });
});

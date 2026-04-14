import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanPartView } from "./plan-part";
import type { DBPlanPart } from "@terragon/shared";

const threePlan: DBPlanPart = {
  type: "plan",
  entries: [
    {
      id: "e1",
      content: "Set up auth module",
      priority: "high",
      status: "completed",
    },
    {
      id: "e2",
      content: "Write unit tests",
      priority: "medium",
      status: "in_progress",
    },
    { id: "e3", content: "Update docs", priority: "low", status: "pending" },
  ],
};

describe("PlanPartView", () => {
  it("renders all three entries", () => {
    const html = renderToStaticMarkup(<PlanPartView part={threePlan} />);
    expect(html).toContain("Set up auth module");
    expect(html).toContain("Write unit tests");
    expect(html).toContain("Update docs");
  });

  it("renders correct priority stripes", () => {
    const html = renderToStaticMarkup(<PlanPartView part={threePlan} />);
    expect(html).toContain('data-priority="high"');
    expect(html).toContain('data-priority="medium"');
    expect(html).toContain('data-priority="low"');
  });

  it("renders correct status icons", () => {
    const html = renderToStaticMarkup(<PlanPartView part={threePlan} />);
    expect(html).toContain('data-status="completed"');
    expect(html).toContain('data-status="in_progress"');
    expect(html).toContain('data-status="pending"');
  });

  it("renders empty plan message for empty entries array", () => {
    const html = renderToStaticMarkup(
      <PlanPartView part={{ type: "plan", entries: [] }} />,
    );
    expect(html).toContain("Empty plan");
  });
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DelegationItemCard } from "./delegation-item-card";
import type { DBDelegationMessage } from "@terragon/shared";

function makeDelegation(
  overrides: Partial<DBDelegationMessage> = {},
): DBDelegationMessage {
  return {
    type: "delegation",
    model: null,
    delegationId: "del-001",
    tool: "spawn",
    status: "initiated",
    senderThreadId: "thread-sender",
    receiverThreadIds: ["thread-a", "thread-b"],
    prompt: "Implement feature X",
    delegatedModel: "claude-3-5-sonnet-20241022",
    reasoningEffort: "medium",
    agentsStates: {},
    ...overrides,
  };
}

describe("DelegationItemCard", () => {
  it("renders initiated status badge", () => {
    const html = renderToStaticMarkup(
      <DelegationItemCard
        delegation={makeDelegation({ status: "initiated" })}
      />,
    );
    expect(html).toContain('data-status="initiated"');
    expect(html).toContain("Initiated");
  });

  it("renders running status badge", () => {
    const html = renderToStaticMarkup(
      <DelegationItemCard delegation={makeDelegation({ status: "running" })} />,
    );
    expect(html).toContain('data-status="running"');
    expect(html).toContain("Running");
  });

  it("renders completed status badge", () => {
    const html = renderToStaticMarkup(
      <DelegationItemCard
        delegation={makeDelegation({ status: "completed" })}
      />,
    );
    expect(html).toContain('data-status="completed"');
    expect(html).toContain("Completed");
  });

  it("renders failed status badge", () => {
    const html = renderToStaticMarkup(
      <DelegationItemCard delegation={makeDelegation({ status: "failed" })} />,
    );
    expect(html).toContain('data-status="failed"');
    expect(html).toContain("Failed");
  });

  it("shows agent count in header", () => {
    const html = renderToStaticMarkup(
      <DelegationItemCard
        delegation={makeDelegation({
          receiverThreadIds: ["a", "b", "c"],
        })}
      />,
    );
    expect(html).toContain("Delegated to 3 agents");
  });

  it("renders model name and reasoning effort", () => {
    const html = renderToStaticMarkup(
      <DelegationItemCard
        delegation={makeDelegation({
          delegatedModel: "gpt-4o",
          reasoningEffort: "high",
        })}
      />,
    );
    expect(html).toContain("gpt-4o");
    expect(html).toContain("high");
  });

  it("renders per-agent statuses", () => {
    const html = renderToStaticMarkup(
      <DelegationItemCard
        delegation={makeDelegation({
          agentsStates: {
            "agent-abc123": "completed",
            "agent-def456": "running",
          },
        })}
      />,
    );
    // Should have both statuses rendered
    const completedCount = (html.match(/data-status="completed"/g) || [])
      .length;
    const runningCount = (html.match(/data-status="running"/g) || []).length;
    expect(completedCount).toBeGreaterThanOrEqual(1);
    expect(runningCount).toBeGreaterThanOrEqual(1);
  });
});

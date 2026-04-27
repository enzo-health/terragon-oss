import { describe, expect, it } from "vitest";
import { shouldSuppressPreStartLifecycleFooter } from "./terragon-thread";

describe("shouldSuppressPreStartLifecycleFooter", () => {
  it("suppresses stale pre-start footer when stream output exists and status is booting", () => {
    expect(
      shouldSuppressPreStartLifecycleFooter({
        threadStatus: "booting",
        hasAgentMessages: true,
      }),
    ).toBe(true);
  });

  it("suppresses queued pre-start footer variants when stream output exists", () => {
    expect(
      shouldSuppressPreStartLifecycleFooter({
        threadStatus: "queued",
        hasAgentMessages: true,
      }),
    ).toBe(true);
    expect(
      shouldSuppressPreStartLifecycleFooter({
        threadStatus: "queued-tasks-concurrency",
        hasAgentMessages: true,
      }),
    ).toBe(true);
  });

  it("keeps footer when no stream output exists or status is already working", () => {
    expect(
      shouldSuppressPreStartLifecycleFooter({
        threadStatus: "booting",
        hasAgentMessages: false,
      }),
    ).toBe(false);
    expect(
      shouldSuppressPreStartLifecycleFooter({
        threadStatus: "working",
        hasAgentMessages: true,
      }),
    ).toBe(false);
  });
});

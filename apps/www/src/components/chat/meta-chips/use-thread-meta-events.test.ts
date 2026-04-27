import { describe, expect, it } from "vitest";
import type { ThreadMetaSnapshot } from "./use-thread-meta-events";
import type { ThreadMetaEvent } from "@terragon/shared/runtime/thread-meta-event";

// ---------------------------------------------------------------------------
// Re-implement the reducer in isolation so tests don't need React / hooks.
// This mirrors the logic in use-thread-meta-events.ts exactly.
// ---------------------------------------------------------------------------

type BootStep = ThreadMetaSnapshot["bootSteps"][number];

function applyEvent(
  state: ThreadMetaSnapshot,
  event: ThreadMetaEvent,
): ThreadMetaSnapshot {
  switch (event.kind) {
    case "thread.token_usage_updated":
      return { ...state, tokenUsage: event.usage };
    case "account.rate_limits_updated":
      return { ...state, rateLimits: event.rateLimits };
    case "model.rerouted":
      return {
        ...state,
        modelReroute: {
          originalModel: event.originalModel,
          reroutedModel: event.reroutedModel,
          reason: event.reason,
        },
      };
    case "mcp_server.startup_status_updated":
      return {
        ...state,
        mcpServerStatus: {
          ...state.mcpServerStatus,
          [event.serverName]: event.status,
        },
      };
    case "boot.substatus_changed": {
      const prevSteps = state.bootSteps;

      // Defense-in-depth dedup: mirrors use-thread-meta-events.ts.
      if (
        prevSteps.length > 0 &&
        prevSteps[prevSteps.length - 1]!.substatus === event.to
      ) {
        return state;
      }

      let updatedSteps: BootStep[] = prevSteps;
      if (prevSteps.length > 0) {
        const last = prevSteps[prevSteps.length - 1]!;
        const durationMs =
          event.durationMs !== undefined
            ? event.durationMs
            : Math.max(
                0,
                new Date(event.timestamp).getTime() -
                  new Date(last.startedAt).getTime(),
              );
        updatedSteps = [
          ...prevSteps.slice(0, -1),
          { ...last, completedAt: event.timestamp, durationMs },
        ];
      }
      return {
        ...state,
        bootSteps: [
          ...updatedSteps,
          { substatus: event.to, startedAt: event.timestamp },
        ],
      };
    }
    case "install.progress":
      return {
        ...state,
        installProgress: {
          resolved: event.resolved,
          reused: event.reused,
          downloaded: event.downloaded,
          added: event.added,
          total: event.total,
          currentPackage: event.currentPackage,
          elapsedMs: event.elapsedMs,
        },
      };
    default:
      return state;
  }
}

const INITIAL: ThreadMetaSnapshot = {
  tokenUsage: null,
  rateLimits: null,
  modelReroute: null,
  mcpServerStatus: {},
  bootSteps: [],
  installProgress: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reducer: boot.substatus_changed", () => {
  it("appends the first step with no prior steps", () => {
    const event: ThreadMetaEvent = {
      kind: "boot.substatus_changed",
      threadId: "t1",
      from: null,
      to: "provisioning",
      timestamp: "2026-01-01T10:00:00.000Z",
    };
    const next = applyEvent(INITIAL, event);
    expect(next.bootSteps).toHaveLength(1);
    const step = next.bootSteps[0]!;
    expect(step.substatus).toBe("provisioning");
    expect(step.startedAt).toBe("2026-01-01T10:00:00.000Z");
    expect(step.completedAt).toBeUndefined();
    expect(step.durationMs).toBeUndefined();
  });

  it("marks the previous step completed when a new step arrives (with explicit durationMs)", () => {
    const state1 = applyEvent(INITIAL, {
      kind: "boot.substatus_changed",
      threadId: "t1",
      from: null,
      to: "provisioning",
      timestamp: "2026-01-01T10:00:00.000Z",
    });
    const state2 = applyEvent(state1, {
      kind: "boot.substatus_changed",
      threadId: "t1",
      from: "provisioning",
      to: "cloning-repo",
      timestamp: "2026-01-01T10:00:05.000Z",
      durationMs: 5000,
    });

    expect(state2.bootSteps).toHaveLength(2);
    expect(state2.bootSteps[0]).toMatchObject({
      substatus: "provisioning",
      completedAt: "2026-01-01T10:00:05.000Z",
      durationMs: 5000,
    });
    const clonStep = state2.bootSteps[1]!;
    expect(clonStep.substatus).toBe("cloning-repo");
    expect(clonStep.startedAt).toBe("2026-01-01T10:00:05.000Z");
    expect(clonStep.completedAt).toBeUndefined();
  });

  it("computes durationMs from timestamps when not provided", () => {
    const state1 = applyEvent(INITIAL, {
      kind: "boot.substatus_changed",
      threadId: "t1",
      from: null,
      to: "provisioning",
      timestamp: "2026-01-01T10:00:00.000Z",
    });
    const state2 = applyEvent(state1, {
      kind: "boot.substatus_changed",
      threadId: "t1",
      from: "provisioning",
      to: "cloning-repo",
      timestamp: "2026-01-01T10:00:03.500Z",
      // no durationMs — should be computed
    });

    expect(state2.bootSteps[0]!.durationMs).toBe(3500);
  });

  it("builds the full 5-step sequence in order", () => {
    const events: ThreadMetaEvent[] = [
      {
        kind: "boot.substatus_changed",
        threadId: "t1",
        from: null,
        to: "provisioning",
        timestamp: "2026-01-01T10:00:00.000Z",
      },
      {
        kind: "boot.substatus_changed",
        threadId: "t1",
        from: "provisioning",
        to: "cloning-repo",
        timestamp: "2026-01-01T10:00:02.000Z",
        durationMs: 2000,
      },
      {
        kind: "boot.substatus_changed",
        threadId: "t1",
        from: "cloning-repo",
        to: "installing-agent",
        timestamp: "2026-01-01T10:00:20.000Z",
        durationMs: 18000,
      },
      {
        kind: "boot.substatus_changed",
        threadId: "t1",
        from: "installing-agent",
        to: "running-setup-script",
        timestamp: "2026-01-01T10:01:00.000Z",
        durationMs: 40000,
      },
      {
        kind: "boot.substatus_changed",
        threadId: "t1",
        from: "running-setup-script",
        to: "booting-done",
        timestamp: "2026-01-01T10:01:05.000Z",
        durationMs: 5000,
      },
    ];

    const finalState = events.reduce((s, e) => applyEvent(s, e), INITIAL);

    expect(finalState.bootSteps).toHaveLength(5);
    expect(finalState.bootSteps.map((s) => s.substatus)).toEqual([
      "provisioning",
      "cloning-repo",
      "installing-agent",
      "running-setup-script",
      "booting-done",
    ]);
    // All but the last step should be completed
    for (let i = 0; i < 4; i++) {
      expect(finalState.bootSteps[i]!.completedAt).toBeDefined();
      expect(finalState.bootSteps[i]!.durationMs).toBeDefined();
    }
    // Last step is still in-progress
    expect(finalState.bootSteps[4]!.completedAt).toBeUndefined();
  });
});

describe("reducer: install.progress", () => {
  it("starts as null", () => {
    expect(INITIAL.installProgress).toBeNull();
  });

  it("sets installProgress on first event", () => {
    const event: ThreadMetaEvent = {
      kind: "install.progress",
      threadId: "t1",
      resolved: 42,
      reused: 10,
      downloaded: 30,
      added: 2,
      total: 100,
      currentPackage: "react",
      elapsedMs: 1500,
    };
    const next = applyEvent(INITIAL, event);
    expect(next.installProgress).toEqual({
      resolved: 42,
      reused: 10,
      downloaded: 30,
      added: 2,
      total: 100,
      currentPackage: "react",
      elapsedMs: 1500,
    });
  });

  it("replaces installProgress on subsequent events", () => {
    const state1 = applyEvent(INITIAL, {
      kind: "install.progress",
      threadId: "t1",
      resolved: 10,
      reused: 0,
      downloaded: 10,
      added: 0,
      elapsedMs: 500,
    });
    const state2 = applyEvent(state1, {
      kind: "install.progress",
      threadId: "t1",
      resolved: 80,
      reused: 20,
      downloaded: 60,
      added: 80,
      total: 200,
      currentPackage: "@tanstack/react-query",
      elapsedMs: 4000,
    });
    expect(state2.installProgress).toMatchObject({
      resolved: 80,
      currentPackage: "@tanstack/react-query",
    });
  });

  it("handles missing optional fields gracefully", () => {
    const event: ThreadMetaEvent = {
      kind: "install.progress",
      threadId: "t1",
      resolved: 5,
      reused: 0,
      downloaded: 5,
      added: 0,
      elapsedMs: 200,
    };
    const next = applyEvent(INITIAL, event);
    expect(next.installProgress!.total).toBeUndefined();
    expect(next.installProgress!.currentPackage).toBeUndefined();
  });
});

describe("reducer: dedup guard for boot.substatus_changed", () => {
  it("ignores duplicate boot.substatus_changed for the same substatus", () => {
    const event: ThreadMetaEvent = {
      kind: "boot.substatus_changed",
      threadId: "t1",
      from: null,
      to: "cloning-repo",
      timestamp: "2026-01-01T10:00:00.000Z",
    };
    const state1 = applyEvent(INITIAL, event);
    // Dispatch the same substatus again — should be a no-op.
    const state2 = applyEvent(state1, {
      kind: "boot.substatus_changed",
      threadId: "t1",
      from: "cloning-repo",
      to: "cloning-repo",
      timestamp: "2026-01-01T10:00:01.000Z",
    });

    expect(state2.bootSteps).toHaveLength(1);
    expect(state2.bootSteps[0]!.substatus).toBe("cloning-repo");
    // The step must NOT be marked completed by the duplicate event.
    expect(state2.bootSteps[0]!.completedAt).toBeUndefined();
  });

  it("reducer handles unknown event kinds on default branch", () => {
    // Cast an unknown kind through the reducer to exercise the default branch.
    const unknown = {
      kind: "unknown.future_event_kind",
      threadId: "t1",
    } as unknown as ThreadMetaEvent;

    // Should return state unchanged without throwing.
    const next = applyEvent(INITIAL, unknown);
    expect(next).toBe(INITIAL);
  });
});

describe("reducer: pre-existing event kinds still work", () => {
  it("token_usage_updated sets tokenUsage", () => {
    const event: ThreadMetaEvent = {
      kind: "thread.token_usage_updated",
      threadId: "t1",
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 50 },
    };
    const next = applyEvent(INITIAL, event);
    expect(next.tokenUsage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
  });

  it("boot and token events compose independently", () => {
    let state = applyEvent(INITIAL, {
      kind: "thread.token_usage_updated",
      threadId: "t1",
      usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 25 },
    });
    state = applyEvent(state, {
      kind: "boot.substatus_changed",
      threadId: "t1",
      from: null,
      to: "provisioning",
      timestamp: "2026-01-01T10:00:00.000Z",
    });
    expect(state.tokenUsage!.inputTokens).toBe(50);
    expect(state.bootSteps).toHaveLength(1);
  });
});

/**
 * Tests for emitLinearActivitiesForDaemonEvent:
 *   - action throttling (max 1/30s per agentSessionId)
 *   - terminal response/error bypass throttle
 *   - legacy fn-1 threads without agentSessionId are skipped
 *   - correct activity content shapes used
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  emitLinearActivitiesForDaemonEvent,
  type LinearClientFactory,
} from "./linear-agent-activity";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/server-lib/linear-oauth", () => ({
  refreshLinearTokenIfNeeded: vi.fn().mockResolvedValue({
    status: "ok",
    accessToken: "test-access-token",
  }),
}));

const mockCreateAgentActivity = vi.fn().mockResolvedValue({ success: true });
const mockLinearClientInstance = {
  createAgentActivity: mockCreateAgentActivity,
};

/** Injectable factory for tests */
const testClientFactory: LinearClientFactory = () =>
  mockLinearClientInstance as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LinearMentionMeta = Extract<
  ThreadSourceMetadata,
  { type: "linear-mention" }
>;

function makeMeta(
  overrides: Partial<LinearMentionMeta> = {},
): LinearMentionMeta {
  return {
    type: "linear-mention",
    agentSessionId: "session-abc",
    organizationId: "org-123",
    issueId: "issue-1",
    issueIdentifier: "PRJ-1",
    issueUrl: "https://linear.app/org/issue/PRJ-1",
    ...overrides,
  };
}

function makeAssistantMessage(text: string) {
  return {
    type: "assistant" as const,
    message: {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
    },
    parent_tool_use_id: null,
    session_id: "session-abc",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emitLinearActivitiesForDaemonEvent", () => {
  beforeEach(() => {
    mockCreateAgentActivity.mockClear();
  });

  it("skips gracefully when agentSessionId is missing (legacy fn-1 thread)", async () => {
    const meta = makeMeta({ agentSessionId: undefined });
    await emitLinearActivitiesForDaemonEvent(meta, [], {
      createClient: testClientFactory,
    });
    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
  });

  it("emits action activity when not throttled", async () => {
    const meta = makeMeta({ agentSessionId: "session-throttle-1" });
    const messages = [makeAssistantMessage("Running tests on auth module")];

    // Use a fake clock starting at t=0
    let fakeNow = 0;
    await emitLinearActivitiesForDaemonEvent(meta, messages, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });

    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "session-throttle-1",
      content: {
        type: "action",
        action: "Running tests on auth module",
      },
    });
  });

  it("throttles action activities: second call within 30s is skipped", async () => {
    const meta = makeMeta({ agentSessionId: "session-throttle-2" });
    const messages = [makeAssistantMessage("Doing work")];

    let fakeNow = 1_000_000;

    // First call — should emit
    await emitLinearActivitiesForDaemonEvent(meta, messages, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
    mockCreateAgentActivity.mockClear();

    // Second call at +15s — should be throttled
    fakeNow += 15_000;
    await emitLinearActivitiesForDaemonEvent(meta, messages, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
  });

  it("allows action after throttle window has passed (>= 30s)", async () => {
    const meta = makeMeta({ agentSessionId: "session-throttle-3" });
    const messages = [makeAssistantMessage("Step 1 done")];

    let fakeNow = 2_000_000;

    // First call
    await emitLinearActivitiesForDaemonEvent(meta, messages, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    mockCreateAgentActivity.mockClear();

    // Advance exactly 30s — should be allowed
    fakeNow += 30_000;
    const messages2 = [makeAssistantMessage("Step 2 done")];
    await emitLinearActivitiesForDaemonEvent(meta, messages2, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "session-throttle-3",
      content: { type: "action", action: "Step 2 done" },
    });
  });

  it("throttle is per-session: different sessions are independent", async () => {
    const metaA = makeMeta({ agentSessionId: "session-A" });
    const metaB = makeMeta({ agentSessionId: "session-B" });
    const messages = [makeAssistantMessage("progress")];

    let fakeNow = 3_000_000;

    // Emit for session A
    await emitLinearActivitiesForDaemonEvent(metaA, messages, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    mockCreateAgentActivity.mockClear();

    // Session B should not be throttled even though A was just emitted
    await emitLinearActivitiesForDaemonEvent(metaB, messages, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
  });

  it("emits response activity for isDone=true, bypasses throttle", async () => {
    const meta = makeMeta({ agentSessionId: "session-done" });
    const messages = [makeAssistantMessage("Task complete. PR created.")];

    let fakeNow = 4_000_000;

    // First: emit an action to set throttle
    await emitLinearActivitiesForDaemonEvent(meta, messages, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    mockCreateAgentActivity.mockClear();

    // Even within 30s window, isDone bypasses throttle
    fakeNow += 5_000;
    await emitLinearActivitiesForDaemonEvent(meta, messages, {
      isDone: true,
      now: () => fakeNow,
      createClient: testClientFactory,
    });

    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
    const call = mockCreateAgentActivity.mock.calls[0]![0];
    expect(call.content.type).toBe("response");
    expect(typeof call.content.body).toBe("string");
    expect(call.content.body.length).toBeGreaterThan(0);
  });

  it("includes cost in response body when costUsd > 0", async () => {
    const meta = makeMeta({ agentSessionId: "session-cost" });
    const messages = [makeAssistantMessage("Done")];

    await emitLinearActivitiesForDaemonEvent(meta, messages, {
      isDone: true,
      costUsd: 0.0042,
      createClient: testClientFactory,
    });

    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
    const call = mockCreateAgentActivity.mock.calls[0]![0];
    expect(call.content.type).toBe("response");
    expect(call.content.body).toContain("0.0042");
  });

  it("emits error activity for isError=true, bypasses throttle", async () => {
    const meta = makeMeta({ agentSessionId: "session-error" });
    const messages = [makeAssistantMessage("stuff")];

    let fakeNow = 5_000_000;

    // Set throttle first
    await emitLinearActivitiesForDaemonEvent(meta, messages, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    mockCreateAgentActivity.mockClear();

    // Error event within 30s — should still emit
    fakeNow += 1_000;
    await emitLinearActivitiesForDaemonEvent(meta, messages, {
      isError: true,
      customErrorMessage: "Sandbox timeout after 300s",
      now: () => fakeNow,
      createClient: testClientFactory,
    });

    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
    const call = mockCreateAgentActivity.mock.calls[0]![0];
    expect(call.content.type).toBe("error");
    expect(call.content.body).toBe("Sandbox timeout after 300s");
  });

  it("uses fallback error body when customErrorMessage is empty", async () => {
    const meta = makeMeta({ agentSessionId: "session-error-2" });

    await emitLinearActivitiesForDaemonEvent(meta, [], {
      isError: true,
      customErrorMessage: null,
      createClient: testClientFactory,
    });

    const call = mockCreateAgentActivity.mock.calls[0]![0];
    expect(call.content.type).toBe("error");
    expect(call.content.body.length).toBeGreaterThan(0);
  });

  it("does not emit action when messages have no assistant text", async () => {
    const meta = makeMeta({ agentSessionId: "session-no-text" });
    // Only a result message (no assistant text)
    const messages = [
      {
        type: "result" as const,
        subtype: "success" as const,
        total_cost_usd: 0,
        duration_ms: 1000,
        duration_api_ms: 900,
        is_error: false,
        num_turns: 1,
        result: "some result",
        session_id: "session-no-text",
      },
    ];

    await emitLinearActivitiesForDaemonEvent(meta, messages as any, {
      createClient: testClientFactory,
    });

    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
  });

  it("truncates assistant text to 200 chars for action activity", async () => {
    const meta = makeMeta({ agentSessionId: "session-truncate" });
    const longText = "A".repeat(300);
    const messages = [makeAssistantMessage(longText)];

    await emitLinearActivitiesForDaemonEvent(meta, messages, {
      createClient: testClientFactory,
    });

    const call = mockCreateAgentActivity.mock.calls[0]![0];
    expect(call.content.type).toBe("action");
    expect(call.content.action.length).toBe(200);
  });

  it("skips all logic when token refresh returns non-ok status", async () => {
    const { refreshLinearTokenIfNeeded } = await import(
      "@/server-lib/linear-oauth"
    );
    (
      refreshLinearTokenIfNeeded as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ status: "reinstall_required" });

    const meta = makeMeta({ agentSessionId: "session-no-token" });
    await emitLinearActivitiesForDaemonEvent(meta, [], {
      isError: true,
      customErrorMessage: "error",
      createClient: testClientFactory,
    });

    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
  });

  it("concurrent invocations for same session only emit one action (throttle slot reserved before first await)", async () => {
    // Simulate two concurrent invocations by using a deferred token refresh:
    // both invocations pass the throttle check nearly simultaneously, but only
    // the first should reserve the slot before the async gap.
    const meta = makeMeta({ agentSessionId: "session-concurrent" });
    const messages = [makeAssistantMessage("concurrent work")];

    let fakeNow = 9_000_000;

    // Track how many token refreshes fire (to confirm both invocations reached the async gap)
    const { refreshLinearTokenIfNeeded } = await import(
      "@/server-lib/linear-oauth"
    );
    let refreshCount = 0;
    (refreshLinearTokenIfNeeded as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        refreshCount++;
        // Simulate async gap
        await Promise.resolve();
        return { status: "ok", accessToken: "test-access-token" };
      },
    );

    // Fire both invocations "simultaneously" (before either can advance the event loop)
    const p1 = emitLinearActivitiesForDaemonEvent(meta, messages, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    const p2 = emitLinearActivitiesForDaemonEvent(meta, messages, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });

    await Promise.all([p1, p2]);

    // Only one emission should have fired — second invocation was blocked by the
    // throttle slot reserved synchronously before the first await
    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
    // Both could reach refresh (throttle slot reserved but second sees reserved slot)
    // OR second is blocked before refresh — both are acceptable outcomes
    expect(refreshCount).toBeGreaterThanOrEqual(1);
  });
});

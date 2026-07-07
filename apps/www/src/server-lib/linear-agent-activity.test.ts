import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  emitLinearActivitiesForCanonicalBatch,
  type LinearClientFactory,
} from "./linear-agent-activity";

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/server-lib/linear-oauth", () => ({
  refreshLinearTokenIfNeeded: vi.fn().mockResolvedValue({
    status: "ok",
    accessToken: "test-access-token",
  }),
}));

const mockCreateAgentActivity = vi.fn().mockResolvedValue({ success: true });
const mockUpdateAgentSession = vi.fn().mockResolvedValue({ success: true });
const mockLinearClientInstance = {
  createAgentActivity: mockCreateAgentActivity,
  updateAgentSession: mockUpdateAgentSession,
};

const testClientFactory: LinearClientFactory = () =>
  mockLinearClientInstance as unknown as import("@linear/sdk").LinearClient;

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

const baseEnvelope = (seq: number) => ({
  payloadVersion: 2 as const,
  eventId: `event-${seq}`,
  runId: "run-1",
  threadId: "thread-1",
  threadChatId: "thread-chat-1",
  seq,
  timestamp: "2026-07-02T00:00:00.000Z",
});

function assistantEvent(text: string, seq = 1): CanonicalEvent {
  return {
    ...baseEnvelope(seq),
    category: "transcript",
    type: "assistant-message",
    messageId: `message-${seq}`,
    content: text,
  };
}

function planEvent(
  entries: Array<{
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed";
  }>,
  seq = 2,
): CanonicalEvent {
  return {
    ...baseEnvelope(seq),
    category: "artifact",
    type: "provider-rich-part",
    richKind: "codex-plan",
    payload: { entries },
  };
}

describe("emitLinearActivitiesForCanonicalBatch", () => {
  beforeEach(() => {
    mockCreateAgentActivity.mockClear();
    mockUpdateAgentSession.mockClear();
  });

  it("skips gracefully when agentSessionId is missing (legacy fn-1 thread)", async () => {
    const meta = makeMeta({ agentSessionId: undefined });
    await emitLinearActivitiesForCanonicalBatch(meta, [], {
      createClient: testClientFactory,
    });
    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
  });

  it("emits action activity when not throttled", async () => {
    const meta = makeMeta({ agentSessionId: "session-throttle-1" });
    const events = [assistantEvent("Running tests on auth module")];

    await emitLinearActivitiesForCanonicalBatch(meta, events, {
      now: () => 0,
      createClient: testClientFactory,
    });

    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "session-throttle-1",
      content: {
        type: "action",
        action: "Working",
        parameter: "Running tests on auth module",
      },
      ephemeral: true,
    });
  });

  it("updates the Linear session plan from the latest canonical plan event", async () => {
    const meta = makeMeta({ agentSessionId: "session-plan" });
    const events = [
      assistantEvent("Planning", 1),
      planEvent(
        [
          {
            content: "Inspect Linear webhook path",
            priority: "high",
            status: "completed",
          },
          {
            content: "Patch prompted repo selection",
            priority: "medium",
            status: "in_progress",
          },
          {
            content: "Run focused tests",
            priority: "low",
            status: "pending",
          },
        ],
        2,
      ),
    ];

    await emitLinearActivitiesForCanonicalBatch(meta, events, {
      createClient: testClientFactory,
    });

    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
    expect(mockUpdateAgentSession).toHaveBeenCalledWith("session-plan", {
      plan: [
        { content: "Inspect Linear webhook path", status: "completed" },
        { content: "Patch prompted repo selection", status: "inProgress" },
        { content: "Run focused tests", status: "pending" },
      ],
    });
  });

  it("throttles action activities: second call within 30s is skipped", async () => {
    const meta = makeMeta({ agentSessionId: "session-throttle-2" });
    const events = [assistantEvent("Doing work")];

    let fakeNow = 1_000_000;

    await emitLinearActivitiesForCanonicalBatch(meta, events, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
    mockCreateAgentActivity.mockClear();

    fakeNow += 15_000;
    await emitLinearActivitiesForCanonicalBatch(meta, events, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
  });

  it("allows action after throttle window has passed (>= 30s)", async () => {
    const meta = makeMeta({ agentSessionId: "session-throttle-3" });

    let fakeNow = 2_000_000;

    await emitLinearActivitiesForCanonicalBatch(
      meta,
      [assistantEvent("Step 1 done")],
      {
        now: () => fakeNow,
        createClient: testClientFactory,
      },
    );
    mockCreateAgentActivity.mockClear();

    fakeNow += 30_000;
    await emitLinearActivitiesForCanonicalBatch(
      meta,
      [assistantEvent("Step 2 done")],
      {
        now: () => fakeNow,
        createClient: testClientFactory,
      },
    );
    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "session-throttle-3",
      content: { type: "action", action: "Working", parameter: "Step 2 done" },
      ephemeral: true,
    });
  });

  it("throttle is per-session: different sessions are independent", async () => {
    const metaA = makeMeta({ agentSessionId: "session-A" });
    const metaB = makeMeta({ agentSessionId: "session-B" });
    const events = [assistantEvent("progress")];

    const fakeNow = 3_000_000;

    await emitLinearActivitiesForCanonicalBatch(metaA, events, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    mockCreateAgentActivity.mockClear();

    await emitLinearActivitiesForCanonicalBatch(metaB, events, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
  });

  it("emits response activity for isDone=true, bypasses throttle", async () => {
    const meta = makeMeta({ agentSessionId: "session-done" });
    const events = [assistantEvent("Task complete. PR created.")];

    let fakeNow = 4_000_000;

    await emitLinearActivitiesForCanonicalBatch(meta, events, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    mockCreateAgentActivity.mockClear();

    fakeNow += 5_000;
    await emitLinearActivitiesForCanonicalBatch(meta, events, {
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
    const events = [assistantEvent("Done")];

    await emitLinearActivitiesForCanonicalBatch(meta, events, {
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
    const events = [assistantEvent("stuff")];

    let fakeNow = 5_000_000;

    await emitLinearActivitiesForCanonicalBatch(meta, events, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    mockCreateAgentActivity.mockClear();

    fakeNow += 1_000;
    await emitLinearActivitiesForCanonicalBatch(meta, events, {
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

    await emitLinearActivitiesForCanonicalBatch(meta, [], {
      isError: true,
      customErrorMessage: null,
      createClient: testClientFactory,
    });

    const call = mockCreateAgentActivity.mock.calls[0]![0];
    expect(call.content.type).toBe("error");
    expect(call.content.body.length).toBeGreaterThan(0);
  });

  it("does not emit action when the batch has no assistant text", async () => {
    const meta = makeMeta({ agentSessionId: "session-no-text" });

    await emitLinearActivitiesForCanonicalBatch(meta, [], {
      createClient: testClientFactory,
    });

    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
  });

  it("truncates assistant text to 200 chars for action activity", async () => {
    const meta = makeMeta({ agentSessionId: "session-truncate" });
    const events = [assistantEvent("A".repeat(300))];

    await emitLinearActivitiesForCanonicalBatch(meta, events, {
      createClient: testClientFactory,
    });

    const call = mockCreateAgentActivity.mock.calls[0]![0];
    expect(call.content.type).toBe("action");
    expect(call.content.parameter.length).toBe(200);
  });

  it("skips all logic when token refresh returns non-ok status", async () => {
    const { refreshLinearTokenIfNeeded } = await import(
      "@/server-lib/linear-oauth"
    );
    (
      refreshLinearTokenIfNeeded as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ status: "reinstall_required" });

    const meta = makeMeta({ agentSessionId: "session-no-token" });
    await emitLinearActivitiesForCanonicalBatch(meta, [], {
      isError: true,
      customErrorMessage: "error",
      createClient: testClientFactory,
    });

    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
  });

  it("concurrent invocations for same session only emit one action (throttle slot reserved before first await)", async () => {
    const meta = makeMeta({ agentSessionId: "session-concurrent" });
    const events = [assistantEvent("concurrent work")];

    const fakeNow = 9_000_000;

    const { refreshLinearTokenIfNeeded } = await import(
      "@/server-lib/linear-oauth"
    );
    let refreshCount = 0;
    (refreshLinearTokenIfNeeded as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        refreshCount++;
        await Promise.resolve();
        return { status: "ok", accessToken: "test-access-token" };
      },
    );

    const p1 = emitLinearActivitiesForCanonicalBatch(meta, events, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });
    const p2 = emitLinearActivitiesForCanonicalBatch(meta, events, {
      now: () => fakeNow,
      createClient: testClientFactory,
    });

    await Promise.all([p1, p2]);

    expect(mockCreateAgentActivity).toHaveBeenCalledOnce();
    expect(refreshCount).toBeGreaterThanOrEqual(1);
  });
});

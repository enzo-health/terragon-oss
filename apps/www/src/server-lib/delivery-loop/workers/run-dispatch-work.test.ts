import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any import that touches them
// ---------------------------------------------------------------------------

const mockGetWorkflow = vi.hoisted(() => vi.fn());
const mockFailWorkItem = vi.hoisted(() => vi.fn());
const mockCompleteWorkItem = vi.hoisted(() => vi.fn());
const mockCreateDispatchIntent = vi.hoisted(() => vi.fn());
const mockCreateDbDispatchIntent = vi.hoisted(() => vi.fn());
const mockMarkDispatchIntentDispatched = vi.hoisted(() => vi.fn());
const mockUpdateThreadChat = vi.hoisted(() => vi.fn());
const mockMaybeProcessFollowUpQueue = vi.hoisted(() => vi.fn());
const mockStartAckTimeout = vi.hoisted(() => vi.fn());
const mockAppendEventAndAdvanceV3 = vi.hoisted(() => vi.fn());
const mockGetLatestAcceptedArtifact = vi.hoisted(() => vi.fn());
const mockGetLatestAgentRunContextForThreadChat = vi.hoisted(() => vi.fn());

vi.mock("@terragon/shared/delivery-loop/store/workflow-store", () => ({
  getWorkflow: mockGetWorkflow,
}));

vi.mock("@terragon/shared/delivery-loop/store/work-queue-store", () => ({
  failWorkItem: mockFailWorkItem,
  completeWorkItem: mockCompleteWorkItem,
}));

vi.mock("../dispatch-intent", () => ({
  createDispatchIntent: mockCreateDispatchIntent,
  getActiveDispatchIntent: vi.fn(),
}));

vi.mock("@terragon/shared/delivery-loop/store/dispatch-intent-store", () => ({
  createDispatchIntent: mockCreateDbDispatchIntent,
  markDispatchIntentDispatched: mockMarkDispatchIntentDispatched,
}));

vi.mock("@terragon/shared/model/threads", () => ({
  updateThreadChat: mockUpdateThreadChat,
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  getLatestAgentRunContextForThreadChat:
    mockGetLatestAgentRunContextForThreadChat,
}));

vi.mock("../ack-lifecycle", () => ({
  DEFAULT_ACK_TIMEOUT_MS: 90_000,
  startAckTimeout: mockStartAckTimeout,
}));

vi.mock("../v3/kernel", () => ({
  appendEventAndAdvanceV3: mockAppendEventAndAdvanceV3,
}));

vi.mock("@/server-lib/process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: mockMaybeProcessFollowUpQueue,
}));

vi.mock("@terragon/shared/delivery-loop/store/artifact-store", () => ({
  getLatestAcceptedArtifact: mockGetLatestAcceptedArtifact,
}));

// Mock the DB query layer
const mockDb = vi.hoisted(() => ({
  query: {
    threadChat: {
      findFirst: vi.fn(),
    },
  },
})) as any;

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { runDispatchWork, type DispatchWorkPayload } from "./run-dispatch-work";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basePayload(
  overrides: Partial<DispatchWorkPayload> = {},
): DispatchWorkPayload {
  return {
    executionClass: "implementation_runtime" as any,
    workflowId: "wf-1",
    ...overrides,
  };
}

function baseParams(payloadOverrides: Partial<DispatchWorkPayload> = {}) {
  return {
    db: mockDb,
    workItemId: "wi-1",
    claimToken: "claim-1",
    payload: basePayload(payloadOverrides),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path mocks
  mockCreateDispatchIntent.mockResolvedValue({ id: "di_1" });
  mockCreateDbDispatchIntent.mockResolvedValue({});
  mockMarkDispatchIntentDispatched.mockResolvedValue({});
  mockUpdateThreadChat.mockResolvedValue({});
  mockMaybeProcessFollowUpQueue.mockResolvedValue({
    processed: true,
    dispatchLaunched: true,
    reason: "dispatch_started_batch",
  });
  mockStartAckTimeout.mockResolvedValue(undefined);
  mockAppendEventAndAdvanceV3.mockResolvedValue({
    inserted: true,
    transitioned: false,
    effectsInserted: 0,
    stateBefore: "implementing",
    stateAfter: "implementing",
  });
  mockCompleteWorkItem.mockResolvedValue(undefined);
  mockFailWorkItem.mockResolvedValue(undefined);
  mockGetLatestAcceptedArtifact.mockResolvedValue(null);
  mockGetLatestAgentRunContextForThreadChat.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDispatchWork", () => {
  it("succeeds for pure v2 workflow", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-v2",
      threadId: "thread-1",
      userId: "user-1",
      kind: "implementing",
      stateJson: {},
    });
    mockDb.query.threadChat.findFirst.mockResolvedValue({
      id: "tc-1",
      threadId: "thread-1",
      status: "active",
    });

    await runDispatchWork(baseParams({ workflowId: "wf-v2" }));

    // Should create dispatch intent using workflow.id as effectiveLoopId
    expect(mockCreateDispatchIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "wf-v2",
        threadId: "thread-1",
        threadChatId: "tc-1",
      }),
    );

    // Should complete the work item (follow-up processed)
    expect(mockCompleteWorkItem).toHaveBeenCalled();
  });

  it("uses workflow.userId for updateThreadChat", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-pure",
      threadId: "thread-1",
      userId: "user-v2",
      kind: "implementing",
      stateJson: {},
    });
    mockDb.query.threadChat.findFirst.mockResolvedValue({
      id: "tc-1",
      threadId: "thread-1",
      status: "active",
    });

    await runDispatchWork(baseParams({ workflowId: "wf-pure" }));

    expect(mockUpdateThreadChat).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-v2",
      }),
    );
  });

  it("includes original task prompt in implementing continuation fallback text", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-1",
      threadId: "thread-1",
      userId: "user-1",
      kind: "implementing",
      stateJson: {},
    });
    mockDb.query.threadChat.findFirst.mockResolvedValue({
      id: "tc-1",
      threadId: "thread-1",
      status: "active",
      title: "Thread title fallback",
      messages: [
        {
          type: "user",
          parts: [{ type: "text", text: "Add comment to README" }],
        },
      ],
    });

    await runDispatchWork(baseParams());

    expect(mockUpdateThreadChat).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: {
          appendQueuedMessages: [
            expect.objectContaining({
              parts: [
                expect.objectContaining({
                  text: expect.stringContaining(
                    "Original task request:\nAdd comment to README",
                  ),
                }),
              ],
            }),
          ],
        },
      }),
    );
  });

  it("fails with workflow_not_found when workflow does not exist", async () => {
    mockGetWorkflow.mockResolvedValue(null);

    await runDispatchWork(baseParams());

    expect(mockFailWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "workflow_not_found",
      }),
    );
    expect(mockCreateDispatchIntent).not.toHaveBeenCalled();
  });

  it("completes without dispatch when workflow is in non-dispatchable state", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-done",
      threadId: "thread-1",
      userId: "user-1",
      kind: "completed",
      stateJson: {},
    });

    await runDispatchWork(baseParams({ workflowId: "wf-done" }));

    expect(mockCompleteWorkItem).toHaveBeenCalled();
    expect(mockCreateDispatchIntent).not.toHaveBeenCalled();
  });

  it("fails with thread_chat_not_found when no threadChat exists", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-1",
      threadId: "thread-1",
      userId: "user-1",
      kind: "implementing",
      stateJson: {},
    });
    mockDb.query.threadChat.findFirst.mockResolvedValue(undefined);

    await runDispatchWork(baseParams());

    expect(mockFailWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "thread_chat_not_found",
      }),
    );
  });

  it("fails with follow_up_not_processed when follow-up queue does not process", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-1",
      threadId: "thread-1",
      userId: "user-1",
      kind: "implementing",
      stateJson: {},
    });
    mockDb.query.threadChat.findFirst.mockResolvedValue({
      id: "tc-1",
      threadId: "thread-1",
      status: "active",
    });
    mockMaybeProcessFollowUpQueue.mockResolvedValue({
      processed: false,
      dispatchLaunched: false,
      reason: "stale_cas",
    });

    await runDispatchWork(baseParams());

    expect(mockFailWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "follow_up_not_processed",
      }),
    );
  });

  it("completes when follow-up queue scheduled a retry", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-1",
      threadId: "thread-1",
      userId: "user-1",
      kind: "implementing",
      stateJson: {},
    });
    mockDb.query.threadChat.findFirst.mockResolvedValue({
      id: "tc-1",
      threadId: "thread-1",
      status: "active",
    });
    mockMaybeProcessFollowUpQueue.mockResolvedValue({
      processed: false,
      dispatchLaunched: false,
      reason: "dispatch_retry_scheduled",
    });

    await runDispatchWork(baseParams());

    expect(mockCompleteWorkItem).toHaveBeenCalled();
    expect(mockFailWorkItem).not.toHaveBeenCalled();
  });

  it("does not enqueue continuation for bootstrap dispatch before active run context exists", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-1",
      threadId: "thread-1",
      userId: "user-1",
      kind: "implementing",
      stateJson: {},
    });
    mockDb.query.threadChat.findFirst.mockResolvedValue({
      id: "tc-1",
      threadId: "thread-1",
      status: "active",
    });

    await runDispatchWork(baseParams({ bootstrap: true }));

    expect(mockUpdateThreadChat).not.toHaveBeenCalled();
    expect(mockMaybeProcessFollowUpQueue).not.toHaveBeenCalled();
    expect(mockFailWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "follow_up_not_processed",
      }),
    );
  });

  it("retries when stale_cas_busy does not confirm a launch", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-1",
      threadId: "thread-1",
      userId: "user-1",
      kind: "implementing",
      stateJson: {},
    });
    mockDb.query.threadChat.findFirst.mockResolvedValue({
      id: "tc-1",
      threadId: "thread-1",
      status: "active",
    });
    mockMaybeProcessFollowUpQueue.mockResolvedValue({
      processed: false,
      dispatchLaunched: false,
      reason: "stale_cas_busy",
    });

    await runDispatchWork(baseParams());

    expect(mockFailWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "follow_up_not_processed",
      }),
    );
    expect(mockCompleteWorkItem).not.toHaveBeenCalled();
  });

  it("attaches to an existing active run without queuing continuation follow-up", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-1",
      threadId: "thread-1",
      userId: "user-1",
      kind: "implementing",
      stateJson: {},
    });
    mockDb.query.threadChat.findFirst.mockResolvedValue({
      id: "tc-1",
      threadId: "thread-1",
      status: "active",
    });
    mockGetLatestAgentRunContextForThreadChat.mockResolvedValue({
      runId: "run-active-1",
      status: "processing",
    });

    await runDispatchWork(baseParams());

    expect(mockCompleteWorkItem).toHaveBeenCalled();
    expect(mockFailWorkItem).not.toHaveBeenCalled();
    expect(mockAppendEventAndAdvanceV3).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "dispatch_sent",
          runId: "run-active-1",
        }),
      }),
    );
    expect(mockUpdateThreadChat).not.toHaveBeenCalled();
    expect(mockMaybeProcessFollowUpQueue).not.toHaveBeenCalled();
    expect(mockStartAckTimeout).not.toHaveBeenCalled();
  });

  it("falls back to legacy ack timeout when v3 dispatch_sent append fails", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-1",
      threadId: "thread-1",
      userId: "user-1",
      kind: "implementing",
      stateJson: {},
    });
    mockDb.query.threadChat.findFirst.mockResolvedValue({
      id: "tc-1",
      threadId: "thread-1",
      status: "active",
    });
    mockAppendEventAndAdvanceV3.mockRejectedValue(new Error("db transient"));

    await runDispatchWork(baseParams());

    expect(mockStartAckTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "wf-1",
        threadId: "thread-1",
        threadChatId: "tc-1",
        userId: "user-1",
      }),
    );
    expect(mockCompleteWorkItem).toHaveBeenCalled();
    expect(mockFailWorkItem).not.toHaveBeenCalled();
  });
});

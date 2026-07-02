import { EventType } from "@ag-ui/core";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import { buildCanonicalEventsForBatch } from "@terragon/daemon/daemon-canonical-events";
import type {
  ClaudeMessage,
  DaemonEventAPIBody,
} from "@terragon/daemon/shared";
import { gitCommitAndPushBranch } from "@terragon/sandbox/commands";
import * as schema from "@terragon/shared/db/schema";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { and, desc, eq } from "drizzle-orm";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import {
  getThread,
  getThreadChat,
  getThreads,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendDaemonMessage } from "@/agent/daemon";
import { db } from "@/lib/db";
import { unwrapResult } from "@/lib/server-actions";
import { getMaxConcurrentTaskCountForUser } from "@/lib/subscription-tiers";
import {
  FollowUpArgs,
  followUp as followUpAction,
  QueueFollowUpArgs,
  queueFollowUp as queueFollowUpAction,
} from "@/server-actions/follow-up";
import {
  NewThreadArgs,
  newThread as newThreadAction,
} from "@/server-actions/new-thread";
import { retryGitCheckpoint } from "@/server-actions/retry-git-checkpoint";
import { retryThread as retryThreadAction } from "@/server-actions/retry-thread";
import {
  cancelScheduledThread as cancelScheduledThreadAction,
  runScheduledThread as runScheduledThreadAction,
} from "@/server-actions/scheduled-thread";
import { stopThread } from "@/server-actions/stop-thread";
import {
  getLatestNativeAgUiSnapshotMessage,
  getNativeAgUiTranscriptForThreadChat,
} from "@/server-lib/ag-ui-side-effect-messages";
import {
  getClaudeRateLimitMessage,
  getClaudeResultMessage,
  saveClaudeTokensForTest,
} from "@/test-helpers/agent";
import {
  mockLoggedInUser,
  mockWaitUntil,
  waitUntilResolved,
} from "@/test-helpers/mock-next";
import { internalPOST } from "./internal-request";
import { maybeStartQueuedThreadChat } from "./process-queued-thread";
import { replay } from "../../test/integration/replayer";

const canonicalRunState = new Map<
  string,
  {
    nextCanonicalSeq: number;
    runStartedEmitted: boolean;
    terminalEmitted: boolean;
    envelopeSeq: number;
  }
>();

function stripRecoverableFromCanonicalTerminal(
  events: CanonicalEvent[],
): CanonicalEvent[] {
  return events.map((event) => {
    if (event.type !== "run-terminal") {
      return event;
    }
    const copy: Record<string, unknown> = { ...event };
    delete copy.recoverable;
    return copy as unknown as CanonicalEvent;
  });
}

const insertProcessingRunContext = async ({
  runId,
  userId,
  threadId,
  threadChatId,
  sandboxId,
}: {
  runId: string;
  userId: string;
  threadId: string;
  threadChatId: string;
  sandboxId: string;
}) => {
  await db.insert(schema.agentRunContext).values({
    runId,
    userId,
    threadId,
    threadChatId,
    sandboxId,
    transportMode: "acp",
    protocolVersion: 2,
    agent: "claudeCode",
    permissionMode: "allowAll",
    requestedSessionId: null,
    resolvedSessionId: null,
    status: "processing",
    tokenNonce: `nonce-${runId}`,
  });
};

const emitDaemonBatch = async ({
  threadId,
  threadChatId,
  userId,
  messages,
  timezone = "America/New_York",
  runId: explicitRunId,
  stripCanonicalRecoverable = false,
}: {
  threadId: string;
  threadChatId: string;
  userId: string;
  messages: ClaudeMessage[];
  timezone?: string;
  runId?: string;
  stripCanonicalRecoverable?: boolean;
}) => {
  const runContext = explicitRunId
    ? await getAgentRunContextByRunId({ db, runId: explicitRunId, userId })
    : ((await db.query.agentRunContext.findFirst({
        where: and(
          eq(schema.agentRunContext.userId, userId),
          eq(schema.agentRunContext.threadId, threadId),
          eq(schema.agentRunContext.threadChatId, threadChatId),
        ),
        orderBy: [
          desc(schema.agentRunContext.createdAt),
          desc(schema.agentRunContext.updatedAt),
        ],
      })) ?? null);
  if (!runContext) {
    throw new Error(
      `emitDaemonBatch: no agent run context for threadChat ${threadChatId}`,
    );
  }
  const runId = runContext.runId;
  const priorState = canonicalRunState.get(runId) ?? {
    nextCanonicalSeq: 0,
    runStartedEmitted: false,
    terminalEmitted: false,
    envelopeSeq: 0,
  };
  const built = buildCanonicalEventsForBatch({
    runId,
    agent: runContext.agent,
    model: null,
    transportMode: runContext.transportMode,
    protocolVersion: runContext.protocolVersion,
    nextCanonicalSeq: priorState.nextCanonicalSeq,
    canonicalRunStartedEmitted: priorState.runStartedEmitted,
    canonicalTerminalEmitted: priorState.terminalEmitted,
    streamedAssistantText: false,
    threadId,
    threadChatId,
    timezone,
    messages,
  });
  canonicalRunState.set(runId, {
    nextCanonicalSeq: built.nextCanonicalSeqAfterBatch,
    runStartedEmitted: built.canonicalRunStartedEmittedAfterBatch,
    terminalEmitted: built.canonicalTerminalEmittedAfterBatch,
    envelopeSeq: priorState.envelopeSeq + 1,
  });
  const canonicalEvents = stripCanonicalRecoverable
    ? stripRecoverableFromCanonicalTerminal(built.canonicalEvents)
    : built.canonicalEvents;
  const body: DaemonEventAPIBody = {
    threadId,
    threadChatId,
    messages,
    timezone,
    transportMode: runContext.transportMode,
    protocolVersion: runContext.protocolVersion,
    payloadVersion: 2,
    eventId: `event-${crypto.randomUUID()}`,
    runId,
    seq: priorState.envelopeSeq,
    canonicalEvents,
  };
  const [result] = await replay([{ wallClockMs: 0, body, headers: {} }], {
    userId,
  });
  if (!result || result.status >= 400) {
    throw new Error(
      `emitDaemonBatch: route rejected batch (${result?.status}): ${JSON.stringify(
        result?.responseBody,
      )}`,
    );
  }
};

const newThread = async (args: NewThreadArgs) => {
  return unwrapResult(
    await newThreadAction({
      ...args,
    }),
  );
};

const runScheduledThread = async ({
  threadId,
  threadChatId,
}: {
  threadId: string;
  threadChatId: string;
}) => {
  return unwrapResult(
    await runScheduledThreadAction({ threadId, threadChatId }),
  );
};

const cancelScheduledThread = async ({
  threadId,
  threadChatId,
}: {
  threadId: string;
  threadChatId: string;
}) => {
  return unwrapResult(
    await cancelScheduledThreadAction({ threadId, threadChatId }),
  );
};

const retryThread = async ({
  threadId,
  threadChatId,
}: {
  threadId: string;
  threadChatId: string;
}) => {
  return unwrapResult(await retryThreadAction({ threadId, threadChatId }));
};

const followUp = async ({ threadId, threadChatId, message }: FollowUpArgs) => {
  return unwrapResult(
    await followUpAction({ threadId, threadChatId, message }),
  );
};

const queueFollowUp = async ({
  threadId,
  threadChatId,
  messages,
}: QueueFollowUpArgs) => {
  return unwrapResult(
    await queueFollowUpAction({ threadId, threadChatId, messages }),
  );
};

describe("end-to-end", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    canonicalRunState.clear();
    vi.mocked(gitCommitAndPushBranch).mockResolvedValue({
      branchName: "test-branch",
    });
    // Ensure all threads are complete so we don't mess other tests.
    await db.update(schema.thread).set({
      status: "complete",
      reattemptQueueAt: null,
    });
    await db.update(schema.threadChat).set({
      status: "complete",
      reattemptQueueAt: null,
    });
  });

  const expectSendDaemonMessageCalledWith = (expected: {
    userId: string;
    threadId: string;
    threadChatId: string;
    sandboxId: string;
    session: unknown;
    message: Record<string, unknown>;
  }) => {
    const normalizedMessage: Record<string, unknown> = { ...expected.message };
    if (normalizedMessage.sessionId === null) {
      delete normalizedMessage.sessionId;
    }

    expect(sendDaemonMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ...expected,
        message: expect.objectContaining(normalizedMessage),
      }),
    );
  };

  it("new thread -> done -> follow up ", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    expect(thread!.name).toBe("test-thread-name");
    expect(thread!.repoBaseBranchName).toBe("main");
    expect(thread!.githubRepoFullName).toBe("terragon/test-repo");
    expect(thread!.gitDiff).toBeNull();

    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat).toBeDefined();
    expect(threadChat!.status).toBe("booting");
    await expect(
      getLatestNativeAgUiSnapshotMessage({ db, threadChatId }),
    ).resolves.toEqual({
      role: "user",
      content: "Hello, world!",
    });
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId: thread!.id,
      threadChatId: threadChat!.id,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: expect.stringContaining("Hello, world!"),
        sessionId: threadChat!.sessionId,
        type: "claude",
        permissionMode: threadChat!.permissionMode,
        agent: threadChat!.agent,
        agentVersion: threadChat!.agentVersion,
      },
    });

    await emitDaemonBatch({
      threadId: thread!.id,
      threadChatId: threadChat!.id,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
    });
    await waitUntilResolved();
    let threadUpdated = await getThread({ db, userId: user.id, threadId });
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(["working", "complete"]).toContain(threadChatUpdated!.status);
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    await emitDaemonBatch({
      threadId: thread!.id,
      threadChatId: threadChat!.id,
      userId: user.id,
      timezone: "America/New_York",
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBeNull();
    expect(threadUpdated!.gitDiff).toMatchInlineSnapshot(`
      "
      diff --git a/test.txt b/test.txt
      index 1234567..89abcdef 100644
      --- a/test.txt
      +++ b/test.txt
      @@ -1 +1 @@
      -Hello, world!
      +Hello, world!
      "
    `);

    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, again" }],
      },
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: threadUpdated!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: expect.stringContaining("Hello, again"),
        sessionId: null,
        type: "claude",
        permissionMode: threadChatUpdated!.permissionMode,
        agent: threadChatUpdated!.agent,
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });

    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, again" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-2",
        },
      ],
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(["working", "complete"]).toContain(threadChatUpdated!.status);

    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBeNull();
  });

  it("new thread -> queue-concurrency-limit -> queued", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    const maxConcurrentTasks = await getMaxConcurrentTaskCountForUser(user.id);
    // Create maxConcurrentTasks threads
    const activeThreadsChatIds: { threadId: string; threadChatId: string }[] =
      [];
    for (let i = 0; i < maxConcurrentTasks; i++) {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          codesandboxId: "mock-sandbox-id",
          sandboxProvider: "mock",
        },
        chatOverrides: {
          status: "working",
        },
      });
      activeThreadsChatIds.push({ threadId, threadChatId });
    }
    await insertProcessingRunContext({
      runId: `run-${crypto.randomUUID()}`,
      userId: user.id,
      threadId: activeThreadsChatIds[0]!.threadId,
      threadChatId: activeThreadsChatIds[0]!.threadChatId,
      sandboxId: "mock-sandbox-id",
    });

    await mockWaitUntil();
    await mockLoggedInUser(session);

    const { threadId, threadChatId } = await newThread({
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      message: {
        type: "user",
        model: "sonnet",
        parts: [
          {
            type: "text",
            text: "Hello! This thread should be queued because of the concurrency limit.",
          },
        ],
      },
    });
    await waitUntilResolved();
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("queued-tasks-concurrency");

    // Update the first active thread to be done.
    await emitDaemonBatch({
      threadId: activeThreadsChatIds[0]!.threadId,
      threadChatId: activeThreadsChatIds[0]!.threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();
    expect(internalPOST).toHaveBeenCalledWith(
      `process-thread-queue/${user.id}`,
    );

    const threadUpdated = await getThread({ db, userId: user.id, threadId });
    const threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: threadUpdated!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: expect.stringContaining(
          "Hello! This thread should be queued because of the concurrency limit.",
        ),
        sessionId: threadChatUpdated!.sessionId,
        type: "claude",
        permissionMode: threadChatUpdated!.permissionMode,
        agent: threadChatUpdated!.agent,
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });
  });

  it("new thread -> stop -> follow up ", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    expect(thread!.name).toBe("test-thread-name");
    expect(thread!.repoBaseBranchName).toBe("main");
    expect(thread!.githubRepoFullName).toBe("terragon/test-repo");
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");

    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: expect.stringContaining("Hello, world!"),
        sessionId: threadChat!.sessionId,
        type: "claude",
        permissionMode: threadChat!.permissionMode,
        agent: threadChat!.agent,
        agentVersion: threadChat!.agentVersion,
      },
    });

    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
    });
    await waitUntilResolved();
    let threadUpdated = await getThread({ db, userId: user.id, threadId });
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(["working", "complete"]).toContain(threadChatUpdated!.status);
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    await stopThread({ threadId, threadChatId });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("stopping");
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: { type: "stop" },
    });

    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [{ type: "custom-stop", session_id: null, duration_ms: 1000 }],
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBeNull();

    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, again" }],
      },
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: threadUpdated!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: expect.stringContaining("Hello, again"),
        sessionId: null,
        type: "claude",
        permissionMode: threadChatUpdated!.permissionMode,
        agent: threadChatUpdated!.agent,
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });
  });

  it("new thread -> agent rate limit -> queued", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });

    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    expect(thread!.name).toBe("test-thread-name");

    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: expect.stringContaining("Hello, world!"),
        sessionId: threadChat!.sessionId,
        type: "claude",
        permissionMode: threadChat!.permissionMode,
        agent: threadChat!.agent,
        agentVersion: threadChat!.agentVersion,
      },
    });

    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
    });
    await waitUntilResolved();
    let threadUpdated = await getThread({ db, userId: user.id, threadId });
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(["working", "complete"]).toContain(threadChatUpdated!.status);
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    const oneHourFromNow = Date.now() + 1000 * 60 * 60;
    const resetTime = Math.floor(oneHourFromNow / 1000) * 1000;
    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        getClaudeRateLimitMessage(resetTime / 1000),
        { type: "custom-error", session_id: null, duration_ms: 1000 },
      ],
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("queued-agent-rate-limit");
    const reattemptQueueAtMs = threadChatUpdated!.reattemptQueueAt!.getTime();
    expect(reattemptQueueAtMs).toBeGreaterThanOrEqual(resetTime);
    expect(reattemptQueueAtMs).toBeLessThan(resetTime + 1000);
    expect(threadUpdated!.gitDiff).toMatchInlineSnapshot(`null`);

    await updateThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      updates: {
        // Update the reattemptQueueAt to be in the past so the thread is eligible
        reattemptQueueAt: new Date(Date.now() - 60 * 1000),
      },
    });

    // Process the queued thread.
    await maybeStartQueuedThreadChat({ userId: user.id });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(threadChatUpdated!.reattemptQueueAt).toBeNull();
  });

  it("new thread -> error -> retry ", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");
    expect(thread!.name).toBe("test-thread-name");
    expect(thread!.repoBaseBranchName).toBe("main");
    expect(thread!.githubRepoFullName).toBe("terragon/test-repo");
    const runId = "run-error-metadata";
    await db.insert(schema.agentRunContext).values({
      runId,
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      transportMode: "acp",
      protocolVersion: 2,
      agent: "claudeCode",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      status: "processing",
      tokenNonce: "nonce-error-metadata",
    });
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: expect.stringContaining("Hello, world!"),
        sessionId: null,
        type: "claude",
        permissionMode: "allowAll",
        agent: "claudeCode",
        agentVersion: threadChat!.agentVersion,
      },
    });

    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      runId,
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
    });
    await waitUntilResolved();
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      runId,
      messages: [
        {
          type: "custom-error",
          session_id: null,
          duration_ms: 1000,
          error_info: "provider not configured",
        },
      ],
    });
    await waitUntilResolved();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBe("agent-generic-error");
    expect(threadChatUpdated!.errorMessageInfo).toBe("provider not configured");
    const runContext = await getAgentRunContextByRunId({
      db,
      runId,
      userId: user.id,
    });
    expect(runContext).toBeDefined();
    expect(runContext!.failureCategory).toBe("config_invalid_provider");
    expect(runContext!.failureSource).toBe("custom-error");
    expect(runContext!.failureRetryable).toBe(false);
    expect(runContext!.failureSignatureHash).not.toBeNull();
    expect(runContext!.failureTerminalReason).toBe("provider not configured");

    await retryThread({ threadId, threadChatId });
    await waitUntilResolved();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(threadChatUpdated!.errorMessage).toBeNull();
  });

  it("new thread -> checkpoint error -> retry git checkpoint", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    expect(thread!.name).toBe("test-thread-name");
    expect(thread!.repoBaseBranchName).toBe("main");
    expect(thread!.githubRepoFullName).toBe("terragon/test-repo");

    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: expect.stringContaining("Hello, world!"),
        sessionId: null,
        type: "claude",
        permissionMode: "allowAll",
        agent: "claudeCode",
        agentVersion: threadChat!.agentVersion,
      },
    });

    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
    });
    await waitUntilResolved();
    let threadUpdated = await getThread({ db, userId: user.id, threadId });
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadUpdated!.branchName).toBeNull();
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    // Mock agent response complete & checkpoint error
    vi.mocked(gitCommitAndPushBranch).mockResolvedValue({
      errorMessage: "git push rejected",
    });
    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });

    // Will retry git checkpoint once
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.errorMessage).toBe(null);
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        sessionId: null,
        type: "claude",
        model: "sonnet",
        prompt:
          "Failed to commit and push changes with the following error: ThreadError: Thread error: git-checkpoint-push-failed: git push rejected. Can you please try again?",
        permissionMode: threadChatUpdated!.permissionMode,
        agent: threadChatUpdated!.agent,
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });

    // Auto fix completed
    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();

    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBe("git-checkpoint-push-failed");
    expect(threadChatUpdated!.errorMessageInfo).toBe("git push rejected");
    expect(threadUpdated!.branchName).toBeNull();

    await retryGitCheckpoint({ threadId, threadChatId });
    vi.mocked(gitCommitAndPushBranch).mockResolvedValue({
      branchName: "test-branch",
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadUpdated!.branchName).toBe("test-branch");
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBeNull();
    expect(threadChatUpdated!.errorMessageInfo).toBeNull();
  });

  it("new thread -> queue message -> done -> processed", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");

    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
    });
    await waitUntilResolved();
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    await queueFollowUp({
      threadId,
      threadChatId,
      messages: [
        {
          type: "user",
          model: "sonnet",
          parts: [{ type: "text", text: "Hello, again" }],
        },
      ],
    });
    await waitUntilResolved();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.queuedMessages).toHaveLength(1);
    expect(threadChatUpdated!.queuedMessages).toEqual([
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, again" }],
      },
    ]);
    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(threadChatUpdated!.errorMessage).toBeNull();
    expect(threadChatUpdated!.queuedMessages).toHaveLength(0);
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: expect.stringContaining("Hello, again"),
        sessionId: null,
        type: "claude",
        permissionMode: threadChatUpdated!.permissionMode,
        agent: threadChatUpdated!.agent,
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });
  });

  it("/clear -> done -> processed", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "complete",
        sessionId: "test-session-id-1",
      },
    });
    const thread = await getThread({ db, userId: user.id, threadId });
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    expect(thread).toBeDefined();
    expect(threadChat!.sessionId).toBe("test-session-id-1");
    expect(threadChat!.status).toBe("complete");

    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "/clear" }],
      },
    });
    await waitUntilResolved();
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.sessionId).toBeNull();
    expect(threadChatUpdated!.errorMessage).toBeNull();
    expect(threadChatUpdated!.errorMessageInfo).toBeNull();
    expect(threadChatUpdated!.contextLength).toBeNull();
    expect(sendDaemonMessage).not.toHaveBeenCalled();
  });

  it("uses AG UI event-log state to fail pending tools for native terminal runs", async () => {
    const { user } = await createTestUser({ db });
    await mockWaitUntil();
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "working",
        appendMessages: [
          {
            type: "tool-call",
            id: "legacy-pending-tool",
            name: "bash",
            parameters: {},
            parent_tool_use_id: null,
          },
        ],
      },
    });
    const runId = `run-${crypto.randomUUID()}`;
    await insertProcessingRunContext({
      runId,
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: "mock-sandbox-id",
    });

    await db.insert(schema.agentEventLog).values({
      eventId: `event-${crypto.randomUUID()}`,
      runId,
      threadId,
      threadChatId,
      seq: 0,
      eventType: "TOOL_CALL_START",
      category: "agui",
      payloadJson: {
        type: EventType.TOOL_CALL_START,
        toolCallId: "native-pending-tool",
        toolCallName: "bash",
        parentMessageId: "native-parent-tool",
      },
      idempotencyKey: `idempotency-${crypto.randomUUID()}`,
      timestamp: new Date(),
    });

    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [{ type: "custom-stop", session_id: null, duration_ms: 1000 }],
      runId,
    });
    await waitUntilResolved();

    const transcript = await getNativeAgUiTranscriptForThreadChat({
      db,
      threadChatId,
    });
    expect(transcript.history).toContain(
      "Tool native-pending-tool failed: Tool execution interrupted by user",
    );
    expect(transcript.history).not.toContain("legacy-pending-tool");
  });

  it("uses an AG UI marker to suppress duplicate invalid-token retry side effects", async () => {
    const { user } = await createTestUser({ db });
    await mockWaitUntil();
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: { status: "working" },
    });
    const revokedMessage = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0,
      duration_ms: 1000,
      duration_api_ms: 1000,
      is_error: true,
      num_turns: 1,
      result: "OAuth token revoked",
      session_id: "test-session-id-1",
    } satisfies Extract<ClaudeMessage, { type: "result" }>;

    const firstRunId = `run-${crypto.randomUUID()}`;
    const secondRunId = `run-${crypto.randomUUID()}`;
    await insertProcessingRunContext({
      runId: firstRunId,
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: "mock-sandbox-id",
    });
    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [revokedMessage],
      runId: firstRunId,
    });
    await waitUntilResolved();
    await insertProcessingRunContext({
      runId: secondRunId,
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: "mock-sandbox-id",
    });
    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [revokedMessage],
      runId: secondRunId,
    });
    await waitUntilResolved();

    await expect(
      getLatestNativeAgUiSnapshotMessage({ db, threadChatId }),
    ).resolves.toEqual({
      role: "system",
      messageType: "invalid-token-retry",
      content: "[invalid-token-retry]",
    });
    const updated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(updated!.queuedMessages ?? []).toHaveLength(0);
    const transcript = await getNativeAgUiTranscriptForThreadChat({
      db,
      threadChatId,
    });
    const invalidTokenRetrySideEffectCount = (
      transcript.history.match(/\[invalid-token-retry\]/g) ?? []
    ).length;
    expect(invalidTokenRetrySideEffectCount).toBe(1);
  });

  it("does not read legacy transcript tool calls when no AG UI tool calls are open at terminal", async () => {
    const { user } = await createTestUser({ db });
    await mockWaitUntil();
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "working",
        appendMessages: [
          {
            type: "tool-call",
            id: "legacy-pending-tool",
            name: "bash",
            parameters: {},
            parent_tool_use_id: null,
          },
        ],
      },
    });
    const runId = `run-${crypto.randomUUID()}`;
    await insertProcessingRunContext({
      runId,
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: "mock-sandbox-id",
    });

    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [{ type: "custom-stop", session_id: null, duration_ms: 1000 }],
      runId,
    });
    await waitUntilResolved();

    const updated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    const toolResults = (updated!.messages ?? []).filter(
      (message) => message.type === "tool-result",
    );
    expect(toolResults).not.toContainEqual(
      expect.objectContaining({ id: "legacy-pending-tool" }),
    );
  });

  it("/compact -> done", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "complete",
        sessionId: "test-session-id-1",
        appendMessages: [
          {
            type: "user",
            model: "sonnet",
            parts: [{ type: "text", text: "Hello, world!" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Hello! How can I help you?" }],
          },
        ],
      },
    });
    const thread = await getThread({ db, userId: user.id, threadId });
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });

    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    expect(thread).toBeDefined();
    expect(threadChat!.sessionId).toBe("test-session-id-1");
    expect(threadChat!.status).toBe("complete");

    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "/compact" }],
      },
    });
    await waitUntilResolved();
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.sessionId).toBeNull();
    expect(threadChatUpdated!.errorMessage).toBeNull();
    expect(threadChatUpdated!.errorMessageInfo).toBeNull();
    expect(threadChatUpdated!.contextLength).toBeNull();
    expect(sendDaemonMessage).not.toHaveBeenCalled();
  });

  it("/compact -> queue message", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);

    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "complete",
        sessionId: "test-session-id-1",
        appendMessages: [
          {
            type: "user",
            model: "sonnet",
            parts: [{ type: "text", text: "Hello, world!" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Hello! How can I help you?" }],
          },
        ],
      },
    });
    const thread = await getThread({ db, userId: user.id, threadId });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    expect(thread).toBeDefined();

    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "/compact" }],
      },
    });
    await queueFollowUp({
      threadId,
      threadChatId,
      messages: [
        {
          type: "user",
          model: "sonnet",
          parts: [{ type: "text", text: "Hello, again" }],
        },
      ],
    });
    await waitUntilResolved();
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(["booting", "complete"]).toContain(threadChatUpdated!.status);
    expect(threadChatUpdated!.queuedMessages).toHaveLength(0);
  });

  it("new thread with plan mode -> follow up with approval", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Create thread with plan mode
    const { threadId, threadChatId } = await newThread({
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello in plan mode" }],
        permissionMode: "plan",
      },
    });
    await waitUntilResolved();

    let threadUpdated = await getThread({ db, userId: user.id, threadId });
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(threadChatUpdated!.permissionMode).toBe("plan");

    // Verify daemon receives plan mode
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: threadUpdated!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: expect.stringContaining("Hello in plan mode"),
        sessionId: null,
        type: "claude",
        permissionMode: "plan",
        agent: "claudeCode",
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });

    // Mock agent response. The current flow can remain "working" while the
    // checkpoint/retry path settles asynchronously.
    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();

    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(["working", "complete"]).toContain(threadChatUpdated!.status);

    // Follow up with approval (switching to allowAll)
    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Proceed" }],
        permissionMode: "allowAll",
      },
    });
    await waitUntilResolved();

    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(threadChatUpdated!.permissionMode).toBe("allowAll");

    // Verify daemon receives allowAll mode after approval
    const lastCall = (sendDaemonMessage as any).mock.calls[
      (sendDaemonMessage as any).mock.calls.length - 1
    ][0];
    expect(lastCall.userId).toBe(user.id);
    expect(lastCall.threadId).toBe(threadId);
    expect(lastCall.threadChatId).toBe(threadChatId);
    expect(lastCall.message.type).toBe("claude");
    expect(lastCall.message.permissionMode).toBe("allowAll");
    // The prompt will include context from the previous message
    expect(lastCall.message.prompt).toContain("Proceed");
  });

  it("queueFollowUp preserves permissionMode", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });

    // Create active thread
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "working",
        permissionMode: "plan",
      },
    });
    await insertProcessingRunContext({
      runId: `run-${crypto.randomUUID()}`,
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: "mock-sandbox-id",
    });
    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Queue follow-up with plan mode
    await queueFollowUp({
      threadId,
      threadChatId,
      messages: [
        {
          type: "user",
          model: "sonnet",
          parts: [{ type: "text", text: "Queued message in plan mode" }],
          permissionMode: "plan",
        },
      ],
    });
    await waitUntilResolved();

    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.queuedMessages).toHaveLength(1);
    expect(threadChatUpdated!.queuedMessages![0]).toMatchObject({
      type: "user",
      parts: [{ type: "text", text: "Queued message in plan mode" }],
      permissionMode: "plan",
    });

    // Complete the thread
    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();

    // Process the queue
    await maybeStartQueuedThreadChat({ userId: user.id });
    await waitUntilResolved();

    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(threadChatUpdated!.permissionMode).toBe("plan");
    expect(threadChatUpdated!.queuedMessages).toHaveLength(0);

    // Verify daemon receives the queued message with plan mode
    const lastCall = (sendDaemonMessage as any).mock.calls[
      (sendDaemonMessage as any).mock.calls.length - 1
    ][0];
    expect(lastCall.userId).toBe(user.id);
    expect(lastCall.threadId).toBe(threadId);
    expect(lastCall.threadChatId).toBe(threadChatId);
    expect(lastCall.message.type).toBe("claude");
    expect(lastCall.message.prompt).toContain("Queued message in plan mode");
    expect(lastCall.message.permissionMode).toBe("plan");
  });

  it("scheduled thread -> runs when scheduled time arrives", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Schedule a thread for 1 hour from now
    const oneHourFromNow = Date.now() + 60 * 60 * 1000;
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Scheduled task message" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      scheduleAt: oneHourFromNow,
    });
    await waitUntilResolved();

    // Verify thread is created with scheduled status
    let thread = await getThread({ db, userId: user.id, threadId });
    let threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(thread).toBeDefined();
    expect(threadChat!.status).toBe("scheduled");
    expect(threadChat!.scheduleAt).toEqual(new Date(oneHourFromNow));
    await expect(
      getNativeAgUiTranscriptForThreadChat({ db, threadChatId }),
    ).resolves.toMatchObject({
      history: expect.stringContaining("user: Scheduled task message"),
    });

    // Daemon should not be called for scheduled threads
    expect(sendDaemonMessage).not.toHaveBeenCalled();

    await updateThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      updates: {
        // Simulate time passing and run the scheduled thread
        scheduleAt: new Date(Date.now() - 1000),
      },
    });

    await internalPOST("cron/scheduled-tasks");
    await waitUntilResolved();
    expect(internalPOST).toHaveBeenCalledWith(
      `process-scheduled-task/${user.id}/${threadId}/${threadChatId}`,
    );
    await waitUntilResolved();

    // Verify thread is now running
    thread = await getThread({ db, userId: user.id, threadId });
    threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");
    expect(threadChat!.scheduleAt).toBeNull();
    expectSendDaemonMessageCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: expect.stringContaining("Scheduled task message"),
        sessionId: null,
        type: "claude",
        permissionMode: "allowAll",
        agent: "claudeCode",
        agentVersion: threadChat!.agentVersion,
      },
    });
  });

  it("scheduled thread -> run now", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });

    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Create a scheduled thread
    const futureTime = Date.now() + 3 * 60 * 60 * 1000; // 3 hours from now
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Scheduled but will run now" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      scheduleAt: futureTime,
    });
    await waitUntilResolved();

    // Verify scheduled state
    let thread = await getThread({ db, userId: user.id, threadId });
    let threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("scheduled");
    expect(threadChat!.scheduleAt).toEqual(new Date(futureTime));

    // Run now
    await runScheduledThread({ threadId, threadChatId });
    await waitUntilResolved();

    // Thread should now be running
    thread = await getThread({ db, userId: user.id, threadId });
    threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(["booting", "complete"]).toContain(threadChat!.status);
    expect(threadChat!.scheduleAt).toBeNull();
    if (threadChat!.status === "booting") {
      expectSendDaemonMessageCalledWith({
        userId: user.id,
        threadId,
        threadChatId,
        sandboxId: thread!.codesandboxId!,
        session: expect.any(Object),
        message: {
          model: "sonnet",
          prompt: expect.stringContaining("Scheduled but will run now"),
          sessionId: null,
          type: "claude",
          permissionMode: "allowAll",
          agent: "claudeCode",
          agentVersion: threadChat!.agentVersion,
        },
      });
    }
  });

  it("scheduled thread -> cancel schedule -> follow up", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });

    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Create a scheduled thread
    const futureTime = Date.now() + 3 * 60 * 60 * 1000; // 3 hours from now
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Scheduled but will cancel schedule" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      scheduleAt: futureTime,
    });

    await waitUntilResolved();
    let thread = await getThread({ db, userId: user.id, threadId });
    let threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("scheduled");
    expect(threadChat!.scheduleAt).toEqual(new Date(futureTime));

    // Cancel schedule
    await cancelScheduledThread({ threadId, threadChatId });
    await waitUntilResolved();

    // Thread should now be complete
    thread = await getThread({ db, userId: user.id, threadId });
    threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("complete");
    expect(threadChat!.scheduleAt).toBeNull();
    expect(sendDaemonMessage).not.toHaveBeenCalled();

    // Follow up
    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Follow up" }],
      },
    });
    await waitUntilResolved();
    thread = await getThread({ db, userId: user.id, threadId });
    threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(["booting", "complete"]).toContain(threadChat!.status);
    if (threadChat!.status === "booting") {
      expectSendDaemonMessageCalledWith({
        userId: user.id,
        threadId,
        threadChatId,
        sandboxId: thread!.codesandboxId!,
        session: expect.any(Object),
        message: {
          model: "sonnet",
          prompt: "Follow up",
          sessionId: null,
          type: "claude",
          permissionMode: "allowAll",
          agent: "claudeCode",
          agentVersion: threadChat!.agentVersion,
        },
      });
    }
  });

  it("scheduled thread -> follow up", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });

    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Create a scheduled thread
    const futureTime = Date.now() + 3 * 60 * 60 * 1000; // 3 hours from now
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Scheduled but will follow up" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      scheduleAt: futureTime,
    });
    await waitUntilResolved();
    let threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("scheduled");
    expect(threadChat!.scheduleAt).toEqual(new Date(futureTime));

    // Follow up
    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Follow up" }],
      },
    });
    await waitUntilResolved();

    threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    // Still scheduled
    expect(threadChat!.status).toBe("scheduled");
    expect(threadChat!.scheduleAt).toEqual(new Date(futureTime));
    const transcript = await getNativeAgUiTranscriptForThreadChat({
      db,
      threadChatId,
    });
    expect(transcript.history).toContain("user: Scheduled but will follow up");
    expect(transcript.history).toContain("user: Follow up");
    expect(sendDaemonMessage).not.toHaveBeenCalledWith();
  });

  it("/compact in queued messages", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const waitForBackgroundTasks = () =>
      Promise.race([
        waitUntilResolved(),
        new Promise((resolve) => setTimeout(resolve, 15_000)),
      ]);

    // Create a thread with some history
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "working",
        sessionId: "test-session-id-1",
        appendMessages: [
          {
            type: "user",
            model: "sonnet",
            parts: [{ type: "text", text: "Initial request" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Working on your request..." }],
          },
        ],
      },
    });
    await insertProcessingRunContext({
      runId: `run-${crypto.randomUUID()}`,
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: "mock-sandbox-id",
    });
    let threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    await waitForBackgroundTasks();
    expect(threadChat!.status).toBe("working");
    expect(threadChat!.messages).toBeNull();

    // Queue follow up
    await queueFollowUp({
      threadId,
      threadChatId,
      messages: [
        {
          type: "user",
          model: "sonnet",
          parts: [{ type: "text", text: "/compact" }],
        },
      ],
    });
    await waitForBackgroundTasks();

    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.queuedMessages).toHaveLength(1);
    expect(threadChatUpdated!.queuedMessages).toEqual([
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "/compact" }],
      },
    ]);

    // Complete the current task
    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [getClaudeResultMessage()],
    });
    await waitForBackgroundTasks();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });

    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.queuedMessages).toHaveLength(0);
  });

  it("handles batch with init and rate limit error", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });

    await mockWaitUntil();
    await mockLoggedInUser(session);

    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(["booting", "complete"]).toContain(threadChat!.status);
    if (threadChat!.status !== "booting") {
      return;
    }

    // Simulate batch of messages from daemon with rate limit error
    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "UTC",
      messages: [
        {
          type: "system",
          subtype: "init",
          session_id: "test-session-id-1",
          tools: [],
          mcp_servers: [],
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Weekly limit reached ∙ resets 6pm",
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          duration_ms: 581,
          duration_api_ms: 0,
          num_turns: 1,
          result: "Weekly limit reached ∙ resets 6pm",
          session_id: "test-session-id-1",
          total_cost_usd: 0,
        },
      ],
    });
    const deadlineMs = Date.now() + 15_000;
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    while (
      threadChatUpdated &&
      threadChatUpdated.status !== "queued-agent-rate-limit" &&
      Date.now() < deadlineMs
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      threadChatUpdated = await getThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
      });
    }

    expect(threadChatUpdated!.status).toBe("queued-agent-rate-limit");
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");
    expect(threadChatUpdated!.errorMessage).toBeNull();
  });

  it("legacy recoverable sniffer classifies a v2 terminal whose canonical run-terminal lacks a recoverable stamp", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();

    const oneHourFromNow = Date.now() + 1000 * 60 * 60;
    const resetTime = Math.floor(oneHourFromNow / 1000) * 1000;
    await emitDaemonBatch({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        getClaudeRateLimitMessage(resetTime / 1000),
        { type: "custom-error", session_id: null, duration_ms: 1000 },
      ],
      stripCanonicalRecoverable: true,
    });
    await waitUntilResolved();

    const threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("queued-agent-rate-limit");
    const reattemptQueueAtMs = threadChatUpdated!.reattemptQueueAt!.getTime();
    expect(reattemptQueueAtMs).toBeGreaterThanOrEqual(resetTime);
    expect(reattemptQueueAtMs).toBeLessThan(resetTime + 1000);
  });
});

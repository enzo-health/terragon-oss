import type { ISandboxSession } from "@terragon/sandbox/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeRunSdlcPrePrReview } from "./pre-pr-review";

const mocks = vi.hoisted(() => ({
  queueFollowUpInternal: vi.fn(),
  runDeepReviewGate: vi.fn(),
  runCarmackReviewGate: vi.fn(),
  isSdlcLoopEnrollmentAllowedForThread: vi.fn(),
  getCurrentBranchName: vi.fn(),
}));

vi.mock("../follow-up", () => ({
  queueFollowUpInternal: mocks.queueFollowUpInternal,
}));

vi.mock("./deep-review-gate", () => ({
  runDeepReviewGate: mocks.runDeepReviewGate,
}));

vi.mock("./carmack-review-gate", () => ({
  runCarmackReviewGate: mocks.runCarmackReviewGate,
}));

vi.mock("./enrollment", () => ({
  isSdlcLoopEnrollmentAllowedForThread:
    mocks.isSdlcLoopEnrollmentAllowedForThread,
}));

vi.mock("@terragon/sandbox/commands", () => ({
  getCurrentBranchName: mocks.getCurrentBranchName,
}));

function makeSession({
  headSha = "head-sha-1",
}: {
  headSha?: string;
} = {}): ISandboxSession {
  return {
    repoDir: "/repo",
    runCommand: vi.fn().mockResolvedValue(headSha),
  } as unknown as ISandboxSession;
}

function makeThread({
  githubPRNumber = null,
}: {
  githubPRNumber?: number | null;
} = {}) {
  return {
    id: "thread-1",
    name: "Task 1",
    branchName: "feature/sdlc",
    githubRepoFullName: "owner/repo",
    githubPRNumber,
    sourceType: "www" as const,
    sourceMetadata: null,
  };
}

function makeFinding({
  title = "Fix race condition",
  isBlocking = true,
}: {
  title?: string;
  isBlocking?: boolean;
} = {}) {
  return {
    title,
    severity: "high" as const,
    category: "correctness",
    detail: "Shared state write is non-atomic",
    suggestedFix: "Use atomic update",
    isBlocking,
  };
}

describe("maybeRunSdlcPrePrReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSdlcLoopEnrollmentAllowedForThread.mockReturnValue(true);
    mocks.getCurrentBranchName.mockResolvedValue("feature/sdlc");
    mocks.queueFollowUpInternal.mockResolvedValue(undefined);
    mocks.runDeepReviewGate.mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });
    mocks.runCarmackReviewGate.mockResolvedValue({
      gatePassed: true,
      blockingFindings: [],
    });
  });

  it("returns early when a PR already exists for the thread", async () => {
    const result = await maybeRunSdlcPrePrReview({
      thread: makeThread({ githubPRNumber: 42 }),
      userId: "user-1",
      threadChatId: "chat-1",
      session: makeSession(),
      diffOutput: "diff",
    });

    expect(result).toBe(true);
    expect(mocks.runDeepReviewGate).not.toHaveBeenCalled();
    expect(mocks.runCarmackReviewGate).not.toHaveBeenCalled();
    expect(mocks.queueFollowUpInternal).not.toHaveBeenCalled();
  });

  it("blocks and queues a follow-up when diff is too large", async () => {
    const result = await maybeRunSdlcPrePrReview({
      thread: makeThread(),
      userId: "user-1",
      threadChatId: "chat-1",
      session: makeSession(),
      diffOutput: "too-large",
    });

    expect(result).toBe(false);
    expect(mocks.runDeepReviewGate).not.toHaveBeenCalled();
    expect(mocks.runCarmackReviewGate).not.toHaveBeenCalled();
    expect(mocks.queueFollowUpInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          expect.objectContaining({
            parts: [
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("PR creation is paused."),
              }),
            ],
          }),
        ],
      }),
    );
  });

  it("ignores non-blocking findings and allows PR creation", async () => {
    mocks.runDeepReviewGate.mockResolvedValueOnce({
      gatePassed: true,
      blockingFindings: [makeFinding({ isBlocking: false })],
    });

    const result = await maybeRunSdlcPrePrReview({
      thread: makeThread(),
      userId: "user-1",
      threadChatId: "chat-1",
      session: makeSession(),
      diffOutput: "diff",
    });

    expect(result).toBe(true);
    expect(mocks.queueFollowUpInternal).not.toHaveBeenCalled();
  });

  it("allows PR creation when one gate execution fails but no blocking findings exist", async () => {
    mocks.runDeepReviewGate.mockRejectedValueOnce(
      new Error("deep review timeout"),
    );

    const result = await maybeRunSdlcPrePrReview({
      thread: makeThread(),
      userId: "user-1",
      threadChatId: "chat-1",
      session: makeSession(),
      diffOutput: "diff",
    });

    expect(result).toBe(true);
    expect(mocks.queueFollowUpInternal).not.toHaveBeenCalled();
  });

  it("blocks and queues findings when a gate reports blocking issues", async () => {
    mocks.runDeepReviewGate.mockResolvedValueOnce({
      gatePassed: false,
      blockingFindings: [makeFinding({ title: "Missing atomic write" })],
    });

    const result = await maybeRunSdlcPrePrReview({
      thread: makeThread(),
      userId: "user-1",
      threadChatId: "chat-1",
      session: makeSession(),
      diffOutput: "diff",
    });

    expect(result).toBe(false);
    expect(mocks.queueFollowUpInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            parts: [
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Missing atomic write"),
              }),
            ],
          }),
        ],
      }),
    );
  });
});

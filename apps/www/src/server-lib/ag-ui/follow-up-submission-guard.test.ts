import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMocks = vi.hoisted(() => ({
  set: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  redis: redisMocks,
}));

import {
  runLockKey,
  submissionDedupeKey,
  withFollowUpSubmissionGuard,
} from "./follow-up-submission-guard";

describe("follow-up submission guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMocks.set.mockResolvedValue("OK");
    redisMocks.del.mockResolvedValue(1);
  });

  it("uses stable Redis keys", () => {
    expect(runLockKey("chat-1")).toBe("lock:run:chat-1");
    expect(
      submissionDedupeKey("user-1", "thread-1", "chat-1", "submission-1"),
    ).toBe("dedupe:ag-ui-submission:user-1:thread-1:chat-1:submission-1");
  });

  it("scopes client submission dedupe by user, thread, and chat", () => {
    const baseKey = submissionDedupeKey(
      "user-1",
      "thread-1",
      "chat-1",
      "submission-1",
    );

    expect(
      submissionDedupeKey("user-2", "thread-1", "chat-1", "submission-1"),
    ).not.toBe(baseKey);
    expect(
      submissionDedupeKey("user-1", "thread-2", "chat-1", "submission-1"),
    ).not.toBe(baseKey);
    expect(
      submissionDedupeKey("user-1", "thread-1", "chat-2", "submission-1"),
    ).not.toBe(baseKey);
  });

  it("runs dispatch behind the run lock when no client submission id exists", async () => {
    const dispatch = vi.fn().mockResolvedValue({ runId: "run-1" });

    const result = await withFollowUpSubmissionGuard({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      clientSubmissionId: null,
      dispatch,
    });

    expect(result).toEqual({ type: "completed", value: { runId: "run-1" } });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(redisMocks.set).toHaveBeenCalledWith("lock:run:chat-1", "1", {
      nx: true,
      ex: 5,
    });
    expect(redisMocks.del).toHaveBeenCalledWith("lock:run:chat-1");
  });

  it("claims a client submission id before acquiring the run lock", async () => {
    const dispatch = vi.fn().mockResolvedValue("ok");

    await withFollowUpSubmissionGuard({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      clientSubmissionId: "submission-1",
      dispatch,
    });

    expect(redisMocks.set).toHaveBeenNthCalledWith(
      1,
      "dedupe:ag-ui-submission:user-1:thread-1:chat-1:submission-1",
      "1",
      { nx: true, ex: 86400 },
    );
    expect(redisMocks.set).toHaveBeenNthCalledWith(2, "lock:run:chat-1", "1", {
      nx: true,
      ex: 5,
    });
  });

  it("skips duplicate submissions before acquiring the run lock", async () => {
    redisMocks.set.mockResolvedValueOnce(null);
    const dispatch = vi.fn().mockResolvedValue("ok");

    const result = await withFollowUpSubmissionGuard({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      clientSubmissionId: "submission-1",
      dispatch,
    });

    expect(result).toEqual({ type: "duplicate-submission" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(redisMocks.set).toHaveBeenCalledOnce();
    expect(redisMocks.del).not.toHaveBeenCalled();
  });

  it("returns lock-held and releases the dedupe claim when another dispatch is running", async () => {
    redisMocks.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    const dispatch = vi.fn().mockResolvedValue("ok");

    const result = await withFollowUpSubmissionGuard({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      clientSubmissionId: "submission-1",
      dispatch,
    });

    expect(result).toEqual({ type: "lock-held" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(redisMocks.del).toHaveBeenCalledWith(
      "dedupe:ag-ui-submission:user-1:thread-1:chat-1:submission-1",
    );
  });

  it("keeps a successful dedupe claim after dispatch completes", async () => {
    await withFollowUpSubmissionGuard({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      clientSubmissionId: "submission-1",
      dispatch: vi.fn().mockResolvedValue("ok"),
    });

    expect(redisMocks.del).not.toHaveBeenCalledWith(
      "dedupe:ag-ui-submission:user-1:thread-1:chat-1:submission-1",
    );
    expect(redisMocks.del).toHaveBeenCalledWith("lock:run:chat-1");
  });

  it("releases both the lock and dedupe claim when dispatch throws", async () => {
    await expect(
      withFollowUpSubmissionGuard({
        userId: "user-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        clientSubmissionId: "submission-1",
        dispatch: vi.fn().mockRejectedValue(new Error("dispatch failed")),
      }),
    ).rejects.toThrow("dispatch failed");

    expect(redisMocks.del).toHaveBeenCalledWith(
      "dedupe:ag-ui-submission:user-1:thread-1:chat-1:submission-1",
    );
    expect(redisMocks.del).toHaveBeenCalledWith("lock:run:chat-1");
  });

  it("keeps dedupe when dispatch marks the durable follow-up as committed before throwing", async () => {
    await expect(
      withFollowUpSubmissionGuard({
        userId: "user-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        clientSubmissionId: "submission-1",
        dispatch: async (markDispatched) => {
          markDispatched();
          throw new Error("post-dispatch lookup failed");
        },
      }),
    ).rejects.toThrow("post-dispatch lookup failed");

    expect(redisMocks.del).not.toHaveBeenCalledWith(
      "dedupe:ag-ui-submission:user-1:thread-1:chat-1:submission-1",
    );
    expect(redisMocks.del).toHaveBeenCalledWith("lock:run:chat-1");
  });
});

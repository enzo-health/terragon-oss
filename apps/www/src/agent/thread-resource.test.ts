import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { User } from "@leo/shared";
import {
  createTestUser,
  createTestThread,
} from "@leo/shared/model/test-helpers";
import { saveClaudeTokensForTest } from "@/test-helpers/agent";
import {
  getThreadChat,
  updateThread,
  getThreadMinimal,
} from "@leo/shared/model/threads";
import { db } from "@/lib/db";
import { withThreadChat, withThreadSandboxSession } from "./thread-resource";
import { ThreadError } from "./error";
import { waitUntilResolved, mockWaitUntil } from "@/test-helpers/mock-next";
import { hibernateSandbox } from "@leo/sandbox";
import { nanoid } from "nanoid/non-secure";

describe("thread-resource", () => {
  let user: User;
  let threadId: string;
  let threadChatId: string;

  beforeAll(async () => {
    await mockWaitUntil();
    const testUserAndAccount = await createTestUser({ db });
    user = testUserAndAccount.user;
    await saveClaudeTokensForTest({ userId: user.id });
  });

  beforeEach(async () => {
    await waitUntilResolved();
    vi.clearAllMocks();
    const createTestThreadResult = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: `mock-sandbox-id-${nanoid()}`,
      },
      chatOverrides: {
        status: "complete",
      },
    });
    threadId = createTestThreadResult.threadId;
    threadChatId = createTestThreadResult.threadChatId;
  });

  describe("withThreadChat", () => {
    it("withThreadChat works", async () => {
      const onError = vi.fn();
      const onExit = vi.fn();
      const result = await withThreadChat({
        threadId,
        threadChatId,
        userId: user.id,
        onError,
        onExit,
        execOrThrow: async (threadChat) => {
          return `Hello, ${threadChat?.id} ${threadChat?.threadId}`;
        },
      });
      expect(result).toBe(`Hello, ${threadChatId} ${threadId}`);
      expect(onError).not.toHaveBeenCalled();
      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith(
        expect.objectContaining({ id: threadChatId, threadId }),
      );
    });

    it("withThreadChat handles unknown errors", async () => {
      const onError = vi.fn();
      const onExit = vi.fn();
      const result = await withThreadChat({
        threadId,
        threadChatId,
        userId: user.id,
        execOrThrow: async () => {
          throw new Error("test error");
        },
        onError,
        onExit,
      });
      expect(result).toBeUndefined();
      const threadChat = await getThreadChat({
        db,
        threadId,
        userId: user.id,
        threadChatId,
      });
      expect(threadChat?.errorMessage).toBe("unknown-error");
      expect(threadChat?.errorMessageInfo).toBe("test error");
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith(
        expect.objectContaining({ id: threadChatId, threadId }),
      );
    });

    it("withThreadChat handles thread-specific errors", async () => {
      const onError = vi.fn();
      const onExit = vi.fn();
      const result = await withThreadChat({
        userId: user.id,
        threadId,
        threadChatId,
        execOrThrow: async () => {
          throw new ThreadError("agent-generic-error", "ERROR MESSAGE", null);
        },
        onError,
        onExit,
      });
      expect(result).toBeUndefined();
      const threadChat = await getThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
      });
      expect(threadChat?.errorMessage).toBe("agent-generic-error");
      expect(threadChat?.errorMessageInfo).toBe("ERROR MESSAGE");
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith(
        expect.objectContaining({ id: threadChatId, threadId }),
      );
    });
  });

  describe("withThreadSandboxSession", () => {
    it("withThreadSandboxSession works", async () => {
      const onExit = vi.fn();
      const onError = vi.fn();
      const onBeforeExec = vi.fn().mockResolvedValue(true);
      expect(hibernateSandbox).not.toHaveBeenCalled();
      const result = await withThreadSandboxSession({
        label: "test-label",
        threadId,
        threadChatId,
        userId: user.id,
        execOrThrow: async ({ threadChat, session }) => {
          return `Hello, ${threadChat?.id} ${threadChat?.threadId}, ${session?.sandboxId}`;
        },
        onError: (error) => {
          console.log("onError", error);
          onError(error);
          expect(error).toBeUndefined();
        },
        onBeforeExec,
        onExit,
      });
      const thread = await getThreadMinimal({ db, threadId, userId: user.id });
      expect(result).toBe(
        `Hello, ${threadChatId} ${threadId}, ${thread?.codesandboxId}`,
      );
      await waitUntilResolved();
      expect(hibernateSandbox).toHaveBeenCalledOnce();
      expect(onBeforeExec).toHaveBeenCalledOnce();
      expect(onBeforeExec).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
      expect(onError).not.toHaveBeenCalled();
      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
    });

    it("withThreadSandboxSession handles errors", async () => {
      const onError = vi.fn();
      const onExit = vi.fn();
      const onBeforeExec = vi.fn().mockResolvedValue(true);
      expect(hibernateSandbox).not.toHaveBeenCalled();
      const result = await withThreadSandboxSession({
        label: "test-label",
        threadId,
        threadChatId,
        userId: user.id,
        execOrThrow: async () => {
          throw new Error("test error");
        },
        onError,
        onExit,
        onBeforeExec,
      });
      expect(result).toBeUndefined();
      await waitUntilResolved();
      expect(hibernateSandbox).toHaveBeenCalledOnce();
      const threadChat = await getThreadChat({
        db,
        threadId,
        userId: user.id,
        threadChatId,
      });
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
      expect(threadChat?.errorMessage).toBe("unknown-error");
      expect(threadChat?.errorMessageInfo).toBe("test error");
      expect(onBeforeExec).toHaveBeenCalled();
      expect(onBeforeExec).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
    });

    it("withThreadSandboxSession handles thread-specific errors", async () => {
      const onError = vi.fn();
      const onExit = vi.fn();
      const onBeforeExec = vi.fn().mockResolvedValue(true);
      expect(hibernateSandbox).not.toHaveBeenCalled();
      const result = await withThreadSandboxSession({
        label: "test-label",
        threadId,
        threadChatId,
        userId: user.id,
        onBeforeExec,
        onExit,
        execOrThrow: async () => {
          throw new ThreadError("agent-generic-error", "ERROR MESSAGE", null);
        },
        onError,
      });
      expect(result).toBeUndefined();
      await waitUntilResolved();
      expect(hibernateSandbox).toHaveBeenCalledOnce();
      const threadChat = await getThreadChat({
        db,
        threadId,
        userId: user.id,
        threadChatId,
      });
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
      expect(threadChat?.errorMessage).toBe("agent-generic-error");
      expect(threadChat?.errorMessageInfo).toBe("ERROR MESSAGE");
      expect(onBeforeExec).toHaveBeenCalled();
      expect(onBeforeExec).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
    });

    it("withThreadSandboxSession handles missing sandbox", async () => {
      await updateThread({
        db,
        userId: user.id,
        threadId,
        updates: { codesandboxId: null },
      });
      const onError = vi.fn();
      const onExit = vi.fn();
      const onBeforeExec = vi.fn().mockResolvedValue(true);
      const result = await withThreadSandboxSession({
        label: "test-label",
        threadId,
        userId: user.id,
        threadChatId,
        execOrThrow: async ({ threadChat, session }) => {
          return `Hello, ${threadChat?.id} ${threadChat?.threadId}, ${session?.sandboxId}`;
        },
        onError,
        onExit,
        onBeforeExec,
      });
      expect(result).toBe(`Hello, ${threadChatId} ${threadId}, undefined`);
      const thread = await getThreadMinimal({
        db,
        threadId,
        userId: user.id,
      });
      const threadChat = await getThreadChat({
        db,
        threadId,
        userId: user.id,
        threadChatId,
      });
      expect(thread?.codesandboxId).toBeNull();
      expect(threadChat?.status).toBe("complete");
      expect(onBeforeExec).toHaveBeenCalled();
      expect(onBeforeExec).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
      expect(onError).not.toHaveBeenCalled();
      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
    });

    it("withThreadSandboxSession works without onBeforeExec callback", async () => {
      const onExit = vi.fn();
      const onError = vi.fn();
      const result = await withThreadSandboxSession({
        label: "test-label",
        threadId,
        threadChatId,
        userId: user.id,
        execOrThrow: async ({ threadChat, session }) => {
          return `Hello, ${threadChat?.id} ${threadChat?.threadId}, ${session?.sandboxId}`;
        },
        onError,
        onExit,
        // onBeforeExec is intentionally undefined
      });
      const thread = await getThreadMinimal({ db, threadId, userId: user.id });
      expect(result).toBe(
        `Hello, ${threadChatId} ${threadId}, ${thread!.codesandboxId}`,
      );
      expect(onError).not.toHaveBeenCalled();
      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
    });

    it("withThreadSandboxSession returns undefined when onBeforeExec returns false", async () => {
      const onExit = vi.fn();
      const onError = vi.fn();
      const onBeforeExec = vi.fn().mockResolvedValue(false);
      const execOrThrow = vi.fn();
      const result = await withThreadSandboxSession({
        label: "test-label",
        threadId,
        userId: user.id,
        threadChatId,
        execOrThrow,
        onError,
        onExit,
        onBeforeExec,
      });
      expect(result).toBeUndefined();
      expect(onBeforeExec).toHaveBeenCalledOnce();
      expect(onBeforeExec).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
      // execOrThrow should not be called when onBeforeExec returns false
      expect(execOrThrow).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
    });

    it("withThreadSandboxSession handles non-function onBeforeExec gracefully", async () => {
      const onExit = vi.fn();
      const onError = vi.fn();
      const result = await withThreadSandboxSession({
        label: "test-label",
        threadId,
        userId: user.id,
        threadChatId,
        execOrThrow: async ({ threadChat, session }) => {
          return `Hello, ${threadChat?.id} ${threadChat?.threadId}, ${session?.sandboxId}`;
        },
        onError,
        onExit,
        // @ts-expect-error - Testing runtime behavior with invalid type
        onBeforeExec: "not-a-function",
      });
      const thread = await getThreadMinimal({ db, threadId, userId: user.id });
      expect(result).toBe(
        `Hello, ${threadChatId} ${threadId}, ${thread!.codesandboxId}`,
      );
      expect(onError).not.toHaveBeenCalled();
      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith({
        threadChat: expect.objectContaining({ id: threadChatId, threadId }),
      });
    });
  });
});

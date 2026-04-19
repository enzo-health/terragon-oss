import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUser, createTestThread } from "./test-helpers";
import { env } from "@terragon/env/pkg-shared";
import { createDb, DB } from "../db";
import { User } from "../db/types";
import {
  markThreadChatAsUnread,
  markThreadChatAsRead,
  markThreadAsRead,
} from "./thread-read-status";
import { getThread, getThreadChat } from "./threads";
import * as broadcastServer from "../broadcast-server";

const db = createDb(env.DATABASE_URL!);

async function isThreadChatRead({
  db,
  userId,
  threadId,
  threadChatId,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
}): Promise<boolean> {
  const threadChat = await getThreadChat({
    db,
    userId,
    threadId,
    threadChatId,
  });
  if (!threadChat) {
    throw new Error("Thread chat not found");
  }
  return !threadChat.isUnread;
}

async function isThreadRead({
  db,
  userId,
  threadId,
}: {
  db: DB;
  userId: string;
  threadId: string;
}): Promise<boolean> {
  const thread = await getThread({ db, userId, threadId });
  if (!thread) {
    throw new Error("Thread not found");
  }
  return !thread.isUnread;
}

describe("thread-read-status", () => {
  let user: User;

  beforeEach(async () => {
    const testUserAndAccount = await createTestUser({ db });
    user = testUserAndAccount.user;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should mark a thread chat as read and unread", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });

    // Initially, no read status exists
    expect(
      await isThreadChatRead({ db, userId: user.id, threadId, threadChatId }),
    ).toBe(true);

    // Mark as read
    await markThreadChatAsRead({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });

    expect(
      await isThreadChatRead({ db, userId: user.id, threadId, threadChatId }),
    ).toBe(true);

    // Mark as unread
    await markThreadChatAsUnread({
      db,
      userId: user.id,
      threadId,
      threadChatIdOrNull: threadChatId,
    });
    expect(
      await isThreadChatRead({ db, userId: user.id, threadId, threadChatId }),
    ).toBe(false);
  });

  it("should mark thread as read when threadChatId is null", async () => {
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
    });
    // Threads start as read
    expect(await isThreadRead({ db, userId: user.id, threadId })).toBe(true);
    // Mark thread as unread with null threadChatId
    await markThreadChatAsUnread({
      db,
      userId: user.id,
      threadId,
      threadChatIdOrNull: null,
    });
    expect(await isThreadRead({ db, userId: user.id, threadId })).toBe(false);
    // Mark thread as read
    await markThreadAsRead({
      db,
      userId: user.id,
      threadId,
    });
    expect(await isThreadRead({ db, userId: user.id, threadId })).toBe(true);
  });

  it("should mark entire thread as read when marking a specific chat as read", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    // Initially starts as read
    expect(await isThreadRead({ db, userId: user.id, threadId })).toBe(true);
    expect(
      await isThreadChatRead({ db, userId: user.id, threadId, threadChatId }),
    ).toBe(true);
    // Mark specific chat as read (should also mark thread as read)
    await markThreadChatAsRead({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    // Both thread and chat should be read
    expect(await isThreadRead({ db, userId: user.id, threadId })).toBe(true);
    expect(
      await isThreadChatRead({ db, userId: user.id, threadId, threadChatId }),
    ).toBe(true);
  });

  it("publishes shell and chat unread patches for chat-level unread events", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        name: "Unread task",
      },
    });
    const publishSpy = vi
      .spyOn(broadcastServer, "publishBroadcastUserMessage")
      .mockResolvedValue(undefined);

    await markThreadChatAsUnread({
      db,
      userId: user.id,
      threadId,
      threadChatIdOrNull: threadChatId,
      shouldPublishRealtimeEvent: true,
    });

    expect(publishSpy).toHaveBeenCalledWith({
      type: "user",
      id: user.id,
      data: {
        threadPatches: [
          {
            threadId,
            threadChatId,
            op: "upsert",
            shell: {
              isUnread: true,
            },
            chat: {
              isUnread: true,
            },
            notifyUnread: {
              threadName: "Unread task",
            },
          },
        ],
      },
    });
  });

  it("publishes shell and chat read patches for chat-level read events", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    const publishSpy = vi
      .spyOn(broadcastServer, "publishBroadcastUserMessage")
      .mockResolvedValue(undefined);

    await markThreadChatAsRead({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      shouldPublishRealtimeEvent: true,
    });

    expect(publishSpy).toHaveBeenCalledWith({
      type: "user",
      id: user.id,
      data: {
        threadPatches: [
          {
            threadId,
            threadChatId,
            op: "upsert",
            shell: {
              isUnread: false,
            },
            chat: {
              isUnread: false,
            },
          },
        ],
      },
    });
  });

  it("publishes shell-only patches for thread-level unread and read events", async () => {
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        name: "Thread-level task",
      },
    });
    const publishSpy = vi
      .spyOn(broadcastServer, "publishBroadcastUserMessage")
      .mockResolvedValue(undefined);

    await markThreadChatAsUnread({
      db,
      userId: user.id,
      threadId,
      threadChatIdOrNull: null,
      shouldPublishRealtimeEvent: true,
    });
    await markThreadAsRead({
      db,
      userId: user.id,
      threadId,
      shouldPublishRealtimeEvent: true,
    });

    expect(publishSpy).toHaveBeenNthCalledWith(1, {
      type: "user",
      id: user.id,
      data: {
        threadPatches: [
          {
            threadId,
            threadChatId: undefined,
            op: "upsert",
            shell: {
              isUnread: true,
            },
            chat: undefined,
            notifyUnread: {
              threadName: "Thread-level task",
            },
          },
        ],
      },
    });
    expect(publishSpy).toHaveBeenNthCalledWith(2, {
      type: "user",
      id: user.id,
      data: {
        threadPatches: [
          {
            threadId,
            op: "upsert",
            shell: {
              isUnread: false,
            },
          },
        ],
      },
    });
  });
});

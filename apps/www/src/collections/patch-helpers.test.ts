import { describe, expect, it } from "vitest";
import type { ThreadPageChat } from "@terragon/shared";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import { validateChatPatch } from "./patch-helpers";

describe("validateChatPatch", () => {
  it("applies newer metadata patches when patch version falls back below the cached version", () => {
    const result = validateChatPatch(
      makeChat({
        status: "queued",
        updatedAt: new Date("2026-03-09T00:00:00.000Z"),
        messageSeq: 2,
        patchVersion: 5,
      }),
      {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "upsert",
        messageSeq: 2,
        patchVersion: 0,
        chat: {
          status: "working",
          updatedAt: "2026-03-09T00:00:10.000Z",
        },
      } as BroadcastThreadPatch,
    );

    expect(result.action).toBe("apply");
    expect(result.nextChat?.status).toBe("working");
    expect(result.nextChat?.patchVersion).toBe(5);
  });
});

function makeChat(overrides: Partial<ThreadPageChat> = {}): ThreadPageChat {
  return {
    id: "chat-1",
    userId: "user-1",
    threadId: "thread-1",
    title: null,
    createdAt: new Date("2026-03-09T00:00:00.000Z"),
    updatedAt: new Date("2026-03-09T00:00:00.000Z"),
    agent: "claudeCode",
    agentVersion: 1,
    status: "complete",
    projectedMessages: [],
    isCanonicalProjection: false,
    queuedMessages: null,
    sessionId: null,
    errorMessage: null,
    errorMessageInfo: null,
    scheduleAt: null,
    reattemptQueueAt: null,
    contextLength: null,
    permissionMode: "allowAll",
    codexPreviousResponseId: null,
    messageSeq: 1,
    messageCount: 0,
    chatSequence: null,
    patchVersion: 1,
    isUnread: false,
    ...overrides,
  };
}

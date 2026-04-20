import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { getSessionOrNull } from "@/lib/auth-server";
import { getThreadReplayEntriesFromCanonicalEvents } from "@terragon/shared/model/agent-event-log";

const dbMocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  return {
    limit,
    where,
    from,
    select,
    db: {
      select,
    },
  };
});

vi.mock("@/lib/auth-server", () => ({
  getSessionOrNull: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: dbMocks.db,
}));

vi.mock("@terragon/shared/model/agent-event-log", () => ({
  getThreadReplayEntriesFromCanonicalEvents: vi.fn(),
}));

describe("thread-replay route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionOrNull).mockResolvedValue({
      session: {
        id: "session-1",
        userId: "user-1",
        expiresAt: new Date(),
        token: "token-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
      },
    } as Awaited<ReturnType<typeof getSessionOrNull>>);
    dbMocks.limit.mockResolvedValue([{ id: "thread-1" }]);
    vi.mocked(getThreadReplayEntriesFromCanonicalEvents).mockResolvedValue([]);
  });

  it("requires an authenticated session", async () => {
    vi.mocked(getSessionOrNull).mockResolvedValue(null);

    const response = await GET(
      new NextRequest("http://localhost/api/thread-replay?threadId=thread-1"),
    );

    expect(response.status).toBe(401);
  });

  it("replays canonical projection entries for message gaps", async () => {
    vi.mocked(getThreadReplayEntriesFromCanonicalEvents).mockResolvedValue([
      {
        seq: 6,
        messages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    ]);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/thread-replay?threadId=thread-1&fromSeq=5",
      ),
    );

    expect(response.status).toBe(200);
    expect(getThreadReplayEntriesFromCanonicalEvents).toHaveBeenCalledWith({
      db: dbMocks.db,
      threadId: "thread-1",
      fromThreadChatMessageSeq: 5,
    });
    await expect(response.json()).resolves.toEqual({
      entries: [
        {
          seq: 6,
          messages: [
            {
              type: "agent",
              parent_tool_use_id: null,
              parts: [{ type: "text", text: "hello" }],
            },
          ],
        },
      ],
      deltaEntries: [],
    });
  });

  it("scopes canonical message replay to the active thread chat when provided", async () => {
    vi.mocked(getThreadReplayEntriesFromCanonicalEvents).mockResolvedValue([
      {
        seq: 6,
        messages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    ]);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/thread-replay?threadId=thread-1&threadChatId=chat-1&fromSeq=5",
      ),
    );

    expect(response.status).toBe(200);
    expect(getThreadReplayEntriesFromCanonicalEvents).toHaveBeenCalledWith({
      db: dbMocks.db,
      threadId: "thread-1",
      threadChatId: "chat-1",
      fromThreadChatMessageSeq: 5,
    });
  });

  it("always returns empty deltaEntries after Task 2C cutover", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/thread-replay?threadId=thread-1&threadChatId=chat-1&fromSeq=5",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      entries: [],
      deltaEntries: [],
    });
  });

  it("requires a fromSeq replay cursor", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/thread-replay?threadId=thread-1"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing replay cursor (fromSeq)",
    });
  });
});

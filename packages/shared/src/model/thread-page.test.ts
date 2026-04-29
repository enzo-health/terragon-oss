import { EventType } from "@ag-ui/core";
import { EVENT_ENVELOPE_VERSION } from "@terragon/agent/canonical-events";
import { env } from "@terragon/env/pkg-shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../db";
import * as schema from "../db/schema";
import {
  appendCanonicalEventsBatch,
  assignThreadChatMessageSeqToCanonicalEvents,
} from "./agent-event-log";
import { createTestThread, createTestUser } from "./test-helpers";
import { getThreadPageChatWithPermissions } from "./thread-page";

const db = createDb(env.DATABASE_URL!);

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("getThreadPageChatWithPermissions", () => {
  it("returns an empty projection when no canonical AG UI replay exists", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    await db
      .update(schema.threadChat)
      .set({
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "legacy prompt" }],
          },
        ],
      })
      .where(eq(schema.threadChat.id, threadChatId));

    const threadChat = await getThreadPageChatWithPermissions({
      db,
      threadId,
      threadChatId,
      userId: user.id,
    });

    expect(threadChat).not.toHaveProperty("messages");
    expect(threadChat?.projectedMessages).toEqual([]);
    expect(threadChat?.messageCount).toBe(0);
  });

  it("hydrates projectedMessages from AG UI side-effect snapshots without assistant replay", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });

    await db.insert(schema.agentEventLog).values({
      eventId: newId("side-effect"),
      runId: newId("run"),
      threadId,
      threadChatId,
      seq: 0,
      eventType: EventType.MESSAGES_SNAPSHOT,
      category: EventType.MESSAGES_SNAPSHOT,
      payloadJson: {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "user-1", role: "user", content: "side-effect prompt" },
        ],
      },
      idempotencyKey: newId("side-effect-key"),
      timestamp: new Date(),
      threadChatMessageSeq: 1,
    });

    const threadChat = await getThreadPageChatWithPermissions({
      db,
      threadId,
      threadChatId,
      userId: user.id,
    });

    expect(threadChat).not.toHaveProperty("messages");
    expect(threadChat?.isCanonicalProjection).toBe(true);
    expect(threadChat?.projectedMessages).toEqual([
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "side-effect prompt" }],
      },
    ]);
    expect(threadChat?.messageCount).toBe(1);
  });

  it("ignores thread_chat messages once AG UI replay projection exists", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    await db
      .update(schema.threadChat)
      .set({
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "ignored thread_chat prompt" }],
          },
        ],
      })
      .where(eq(schema.threadChat.id, threadChatId));

    await db.insert(schema.agentEventLog).values({
      eventId: newId("side-effect"),
      runId: newId("run"),
      threadId,
      threadChatId,
      seq: 0,
      eventType: EventType.MESSAGES_SNAPSHOT,
      category: EventType.MESSAGES_SNAPSHOT,
      payloadJson: {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [{ id: "user-1", role: "user", content: "ag-ui prompt" }],
      },
      idempotencyKey: newId("side-effect-key"),
      timestamp: new Date(),
      threadChatMessageSeq: 1,
    });

    const threadChat = await getThreadPageChatWithPermissions({
      db,
      threadId,
      threadChatId,
      userId: user.id,
    });

    expect(threadChat?.projectedMessages).toEqual([
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "ag-ui prompt" }],
      },
    ]);
    expect(threadChat?.messageCount).toBe(1);
  });

  it("does not prepend thread_chat prompts before a compact-result snapshot", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    await db
      .update(schema.threadChat)
      .set({
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "ignored pre-compact prompt" }],
          },
        ],
      })
      .where(eq(schema.threadChat.id, threadChatId));

    await db.insert(schema.agentEventLog).values({
      eventId: newId("side-effect"),
      runId: newId("run"),
      threadId,
      threadChatId,
      seq: 0,
      eventType: EventType.MESSAGES_SNAPSHOT,
      category: EventType.MESSAGES_SNAPSHOT,
      payloadJson: {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          {
            id: "side-effect-system:compact-result-1-abcdef123456",
            role: "system",
            content: "Context compacted",
          },
        ],
      },
      idempotencyKey: newId("side-effect-key"),
      timestamp: new Date(),
      threadChatMessageSeq: 1,
    });

    const threadChat = await getThreadPageChatWithPermissions({
      db,
      threadId,
      threadChatId,
      userId: user.id,
    });

    expect(threadChat?.projectedMessages).toEqual([
      {
        type: "system",
        message_type: "compact-result",
        parts: [{ type: "text", text: "Context compacted" }],
      },
    ]);
    expect(threadChat?.messageCount).toBe(1);
  });

  it("hydrates projectedMessages from canonical replay when replay rows exist", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    await db
      .update(schema.threadChat)
      .set({
        messages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "ignored thread_chat assistant" }],
          },
        ],
      })
      .where(eq(schema.threadChat.id, threadChatId));
    const runId = newId("run");
    const eventIds = [newId("event"), newId("event")];

    const results = await appendCanonicalEventsBatch({
      db,
      events: [
        {
          payloadVersion: EVENT_ENVELOPE_VERSION,
          eventId: eventIds[0],
          runId,
          threadId,
          threadChatId,
          seq: 0,
          timestamp: new Date().toISOString(),
          category: "operational",
          type: "run-started",
          agent: "codex",
          model: "gpt-5.4",
          transportMode: "legacy",
          protocolVersion: 2,
        },
        {
          payloadVersion: EVENT_ENVELOPE_VERSION,
          eventId: eventIds[1],
          runId,
          threadId,
          threadChatId,
          seq: 1,
          timestamp: new Date().toISOString(),
          category: "transcript",
          type: "assistant-message",
          messageId: newId("message"),
          content: "canonical assistant reply",
        },
      ],
    });
    expect(results.every((result) => result.success)).toBe(true);

    await assignThreadChatMessageSeqToCanonicalEvents({
      db,
      eventIds,
      threadChatMessageSeq: 1,
    });

    const threadChat = await getThreadPageChatWithPermissions({
      db,
      threadId,
      threadChatId,
      userId: user.id,
    });

    expect(threadChat).not.toHaveProperty("messages");
    expect(threadChat?.projectedMessages).toEqual([
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "canonical assistant reply" }],
      },
    ]);
    expect(threadChat?.messageCount).toBe(1);
  });

  it("returns an empty projection when canonical replay schema is unavailable", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    await db
      .update(schema.threadChat)
      .set({
        messages: [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "legacy prompt" }],
          },
        ],
      })
      .where(eq(schema.threadChat.id, threadChatId));

    const findFirstSpy = vi
      .spyOn(db.query.agentEventLog, "findFirst")
      .mockRejectedValue(
        Object.assign(new Error('relation "agent_event_log" does not exist'), {
          code: "42P01",
        }),
      );

    try {
      const threadChat = await getThreadPageChatWithPermissions({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });

      expect(threadChat).not.toHaveProperty("messages");
      expect(threadChat?.projectedMessages).toEqual([]);
      expect(threadChat?.messageCount).toBe(0);
    } finally {
      findFirstSpy.mockRestore();
    }
  });
});

import { describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { EVENT_ENVELOPE_VERSION } from "@terragon/agent/canonical-events";
import { createDb } from "../db";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";
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
  it("falls back to legacy thread chat messages when no canonical projection exists", async () => {
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

    expect(threadChat?.messages).toEqual([
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "legacy prompt" }],
      },
    ]);
    expect(threadChat?.projectedMessages).toEqual(threadChat?.messages);
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
            type: "user",
            model: null,
            parts: [{ type: "text", text: "legacy user prompt" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "legacy assistant reply" }],
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

    expect(threadChat?.messages).toEqual([
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "legacy user prompt" }],
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "legacy assistant reply" }],
      },
    ]);
    expect(threadChat?.projectedMessages).toEqual([
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "canonical assistant reply" }],
      },
    ]);
  });
});

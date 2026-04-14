/**
 * DB roundtrip test for the new DBDelegationMessage variant introduced in Sprint 1.
 *
 * Inserts a row into the thread_chat table (which has a `messages: jsonb` column
 * typed as DBMessage[]) containing a DBDelegationMessage, reads it back via
 * Drizzle, and deep-equals the round-tripped value.
 *
 * Requires a live Postgres database — uses the same global vitest setup as the
 * rest of packages/shared (see vitest.config.ts + globalSetup).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import * as schema from "./schema";
import { createTestUser, createTestThread } from "../model/test-helpers";
import type { User } from "./types";
import type { DBMessage } from "./db-message";
import { DB_MESSAGE_SCHEMA_VERSION } from "./db-message";

const db = createDb(env.DATABASE_URL!);

describe("DBDelegationMessage — DB roundtrip", () => {
  let user: User;
  let threadId: string;
  let threadChatId: string;

  beforeEach(async () => {
    const testUser = await createTestUser({ db });
    user = testUser.user;
    const result = await createTestThread({
      db,
      userId: user.id,
      enableThreadChatCreation: true,
    });
    threadId = result.threadId;
    threadChatId = result.threadChatId;
  });

  it("round-trips a DBDelegationMessage through the JSONB messages column", async () => {
    const delegation: DBMessage = {
      type: "delegation",
      model: null,
      delegationId: "item_collab_rt_001",
      tool: "message",
      status: "completed",
      senderThreadId: "sender-rt-thread",
      receiverThreadIds: ["receiver-rt-a", "receiver-rt-b"],
      prompt: "Round-trip test prompt",
      delegatedModel: "claude-3-5-sonnet-20241022",
      reasoningEffort: "medium",
      agentsStates: {
        "receiver-rt-a": "completed",
        "receiver-rt-b": "completed",
      },
      timestamp: "2026-04-14T00:00:00.000Z",
    };

    const messages: DBMessage[] = [delegation];

    // Write
    await db
      .update(schema.threadChat)
      .set({ messages })
      .where(eq(schema.threadChat.id, threadChatId));

    // Read back
    const rows = await db
      .select({ messages: schema.threadChat.messages })
      .from(schema.threadChat)
      .where(eq(schema.threadChat.id, threadChatId));

    expect(rows).toHaveLength(1);
    const roundTripped = rows[0]!.messages;
    expect(roundTripped).toHaveLength(1);
    expect(roundTripped![0]).toEqual(delegation);
  });

  it("round-trips multiple message types including DBDelegationMessage in a single array", async () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Kick off delegation" }],
      },
      {
        type: "delegation",
        model: null,
        delegationId: "item_multi_001",
        tool: "spawn",
        status: "initiated",
        senderThreadId: "sender-multi",
        receiverThreadIds: ["child-a"],
        prompt: "Sub-agent task",
        delegatedModel: "claude-3-haiku-20240307",
        agentsStates: { "child-a": "initiated" },
      },
      {
        type: "stop",
      },
    ];

    await db
      .update(schema.threadChat)
      .set({ messages })
      .where(eq(schema.threadChat.id, threadChatId));

    const rows = await db
      .select({ messages: schema.threadChat.messages })
      .from(schema.threadChat)
      .where(eq(schema.threadChat.id, threadChatId));

    expect(rows[0]!.messages).toEqual(messages);
  });

  it("schema version is exported and equals 1", () => {
    // Sanity-check that the constant travels through the module boundary correctly.
    expect(DB_MESSAGE_SCHEMA_VERSION).toBe(1);
  });
});

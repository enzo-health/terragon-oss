import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid/non-secure";
import { env } from "@leo/env/pkg-shared";
import { createDb, type DB } from "../../db";
import * as schema from "../../db/schema";
import { createTestThread, createTestUser } from "../../model/test-helpers";
import {
  createDispatchIntent,
  type CreateDispatchIntentInput,
} from "./dispatch-intent-store";

describe("createDispatchIntent", () => {
  let db: DB;
  let threadId: string;
  let threadChatId: string;
  let baseInput: Omit<CreateDispatchIntentInput, "runId">;

  beforeEach(async () => {
    db = createDb(env.DATABASE_URL!);
    const { user } = await createTestUser({ db });
    const createdThread = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "leo/test-repo" },
    });
    threadId = createdThread.threadId;
    threadChatId = createdThread.threadChatId;
    baseInput = {
      loopId: nanoid(),
      threadId,
      threadChatId,
      targetPhase: "implementing",
      selectedAgent: "claudeCode",
      executionClass: "implementation_runtime",
      dispatchMechanism: "self_dispatch",
    };
  });

  it("is idempotent on runId under concurrent duplicate creates", async () => {
    const runId = `run-${nanoid()}`;

    const [firstId, secondId] = await Promise.all([
      createDispatchIntent(db, {
        ...baseInput,
        runId,
      }),
      createDispatchIntent(db, {
        ...baseInput,
        runId,
      }),
    ]);

    expect(firstId).toBeTruthy();
    expect(secondId).toBe(firstId);

    const rows = await db
      .select()
      .from(schema.deliveryLoopDispatchIntent)
      .where(eq(schema.deliveryLoopDispatchIntent.runId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(firstId);
  });
});

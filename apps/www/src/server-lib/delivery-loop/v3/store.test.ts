import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { ensureWorkflowHead, getActiveWorkflowForThread } from "./store";

let testUserId: string;
let testThreadId: string;

beforeEach(async () => {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({ db, userId: user.id });
  testUserId = user.id;
  testThreadId = threadId;
});

describe("getActiveWorkflowForThread", () => {
  it("returns null when the only head is terminal", async () => {
    const workflow = await createWorkflow({
      db,
      threadId: testThreadId,
      generation: 1,
      kind: "terminated",
      stateJson: {},
      repoFullName: "test-org/test-repo",
      userId: testUserId,
    });
    await ensureWorkflowHead({ db, workflowId: workflow.id });
    await db
      .update(schema.deliveryWorkflowHeadV3)
      .set({
        state: "terminated",
        blockedReason: "done",
      })
      .where(eq(schema.deliveryWorkflowHeadV3.workflowId, workflow.id));

    await expect(
      getActiveWorkflowForThread({ db, threadId: testThreadId }),
    ).resolves.toBeNull();
  });

  it("prefers the highest-generation non-terminal head", async () => {
    const firstWorkflow = await createWorkflow({
      db,
      threadId: testThreadId,
      generation: 1,
      kind: "planning",
      stateJson: { planVersion: null },
      repoFullName: "test-org/test-repo",
      userId: testUserId,
    });
    await ensureWorkflowHead({ db, workflowId: firstWorkflow.id });

    const secondWorkflow = await createWorkflow({
      db,
      threadId: testThreadId,
      generation: 2,
      kind: "planning",
      stateJson: { planVersion: null },
      repoFullName: "test-org/test-repo",
      userId: testUserId,
    });
    await ensureWorkflowHead({ db, workflowId: secondWorkflow.id });

    await expect(
      getActiveWorkflowForThread({ db, threadId: testThreadId }),
    ).resolves.toEqual(
      expect.objectContaining({
        workflow: expect.objectContaining({ id: secondWorkflow.id }),
        head: expect.objectContaining({ workflowId: secondWorkflow.id }),
      }),
    );
  });
});

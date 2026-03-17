import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { enrollV2Workflow } from "./v2-enrollment";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testUserId: string;
let testThreadId: string;

beforeEach(async () => {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({ db, userId: user.id });
  testUserId = user.id;
  testThreadId = threadId;
});

async function getWorkItemsForWorkflow(workflowId: string) {
  return db
    .select()
    .from(schema.deliveryWorkItem)
    .where(eq(schema.deliveryWorkItem.workflowId, workflowId));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enrollV2Workflow", () => {
  it("creates a dispatch work item with bootstrap flag on new enrollment", async () => {
    const result = await enrollV2Workflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    const workItems = await getWorkItemsForWorkflow(result.workflowId);

    expect(workItems).toHaveLength(1);
    expect(workItems[0]!.kind).toBe("dispatch");
    expect(workItems[0]!.status).toBe("pending");

    const payload = workItems[0]!.payloadJson as Record<string, unknown>;
    expect(payload.bootstrap).toBe(true);
    expect(payload.executionClass).toBe("implementation_runtime");
    expect(payload.workflowId).toBe(result.workflowId);
  });

  it("does NOT create duplicate work items on idempotent re-enrollment", async () => {
    const first = await enrollV2Workflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    const second = await enrollV2Workflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    // Same workflow returned
    expect(second.workflowId).toBe(first.workflowId);

    // Still only one dispatch work item
    const workItems = await getWorkItemsForWorkflow(first.workflowId);
    expect(workItems).toHaveLength(1);
  });

  it("returns sdlcLoopId as null for pure v2 enrollment", async () => {
    const result = await enrollV2Workflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    expect(result.workflowId).toBeTruthy();
    // sdlcLoopId is always null — v1 sdlcLoop table no longer exists
    expect(result.sdlcLoopId).toBeNull();
  });
});

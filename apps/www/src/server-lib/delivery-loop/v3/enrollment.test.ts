import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { enrollWorkflow } from "./enrollment";
import { getWorkflowHead } from "./store";

let testUserId: string;
let testThreadId: string;

beforeEach(async () => {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({ db, userId: user.id });
  testUserId = user.id;
  testThreadId = threadId;
});

describe("enrollWorkflow", () => {
  it("creates a delivery_workflow row in planning state", async () => {
    const result = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    expect(result.workflowId).toBeTruthy();

    const workflow = await db.query.deliveryWorkflow.findFirst({
      where: eq(schema.deliveryWorkflow.id, result.workflowId),
    });
    expect(workflow).toBeTruthy();
    expect(workflow!.kind).toBe("planning");
    expect(workflow!.threadId).toBe(testThreadId);
    expect(workflow!.userId).toBe(testUserId);
  });

  it("creates a v3 head row that transitions to awaiting implementation acceptance after bootstrap", async () => {
    const result = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    const head = await getWorkflowHead({
      db,
      workflowId: result.workflowId,
    });
    expect(head).toBeTruthy();
    // bootstrap now queues dispatch and waits for explicit acceptance before implementing
    expect(head!.state).toBe("awaiting_implementation_acceptance");
    expect(head!.version).toBeGreaterThan(0);
  });

  it("inserts a bootstrap journal event", async () => {
    const result = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    const journal = await db.query.deliveryLoopJournalV3.findFirst({
      where: and(
        eq(schema.deliveryLoopJournalV3.workflowId, result.workflowId),
        eq(schema.deliveryLoopJournalV3.eventType, "bootstrap"),
      ),
    });
    expect(journal).toBeTruthy();
    expect(journal!.source).toBe("system");
  });

  it("creates a dispatch_implementing effect", async () => {
    const result = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    const effects = await db
      .select()
      .from(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, result.workflowId));
    const dispatchEffect = effects.find(
      (e) => e.effectKind === "dispatch_implementing",
    );
    expect(dispatchEffect).toBeTruthy();
    // Effect may be "planned" or already "succeeded" (eager inline drain)
    expect(["planned", "succeeded"]).toContain(dispatchEffect!.status);
  });

  it("is idempotent — returns existing workflow on re-enrollment", async () => {
    const first = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    const effectsAfterFirstEnroll = await db
      .select()
      .from(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, first.workflowId));
    const firstDispatchEffects = effectsAfterFirstEnroll.filter(
      (e) => e.effectKind === "dispatch_implementing",
    );

    const second = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    expect(second.workflowId).toBe(first.workflowId);

    // Re-enrollment must not enqueue additional implementing dispatch effects.
    const effectsAfterSecondEnroll = await db
      .select()
      .from(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, first.workflowId));
    const secondDispatchEffects = effectsAfterSecondEnroll.filter(
      (e) => e.effectKind === "dispatch_implementing",
    );
    expect(secondDispatchEffects).toHaveLength(firstDispatchEffects.length);
  });

  it("respects planApprovalPolicy", async () => {
    const result = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
      planApprovalPolicy: "human_required",
    });

    const workflow = await db.query.deliveryWorkflow.findFirst({
      where: eq(schema.deliveryWorkflow.id, result.workflowId),
    });
    expect(workflow!.planApprovalPolicy).toBe("human_required");
  });

  it("increments generation for the same thread", async () => {
    // Enroll, then terminate, then re-enroll
    const first = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    // Terminate the first workflow so idempotency check allows re-enrollment
    await db
      .update(schema.deliveryWorkflow)
      .set({ kind: "terminated" })
      .where(eq(schema.deliveryWorkflow.id, first.workflowId));

    const second = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    expect(second.workflowId).not.toBe(first.workflowId);

    const secondWorkflow = await db.query.deliveryWorkflow.findFirst({
      where: eq(schema.deliveryWorkflow.id, second.workflowId),
    });
    expect(secondWorkflow!.generation).toBe(2);
  });
});

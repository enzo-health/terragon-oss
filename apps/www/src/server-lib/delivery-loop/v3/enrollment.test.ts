import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { enrollWorkflow } from "./enrollment";
import { getActiveWorkflowForThreadV3, getWorkflowHead } from "./store";

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

  it("creates a v3 head row that stays in planning after bootstrap", async () => {
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
    // Enrollment preserves the planning boundary, but eager effect draining can
    // already allocate/queue the planning run lease before we read the head.
    expect(head!.state).toBe("planning");
    expect(head!.version).toBeGreaterThan(0);
    expect(head!.activeRunSeq).toBeGreaterThan(0);
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
    await db
      .update(schema.deliveryWorkflowHeadV3)
      .set({
        state: "terminated",
        blockedReason: "done",
      })
      .where(eq(schema.deliveryWorkflowHeadV3.workflowId, first.workflowId));

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

  it("treats a non-terminal v3 head as the existing workflow even if the legacy row is terminal", async () => {
    const first = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    await db
      .update(schema.deliveryWorkflow)
      .set({ kind: "terminated" })
      .where(eq(schema.deliveryWorkflow.id, first.workflowId));

    await db
      .update(schema.deliveryWorkflowHeadV3)
      .set({
        state: "implementing",
        blockedReason: null,
      })
      .where(eq(schema.deliveryWorkflowHeadV3.workflowId, first.workflowId));

    const second = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    expect(second.workflowId).toBe(first.workflowId);

    const workflows = await db.query.deliveryWorkflow.findMany({
      where: eq(schema.deliveryWorkflow.threadId, testThreadId),
    });
    expect(workflows).toHaveLength(1);
  });

  it("recovers a planning workflow row that exists without a v3 head", async () => {
    const orphan = await createWorkflow({
      db,
      threadId: testThreadId,
      generation: 1,
      kind: "planning",
      stateJson: { planVersion: null },
      repoFullName: "test-org/test-repo",
      userId: testUserId,
    });

    const result = await enrollWorkflow({
      db,
      threadId: testThreadId,
      userId: testUserId,
      repoFullName: "test-org/test-repo",
    });

    expect(result.workflowId).toBe(orphan.id);
    await expect(
      getActiveWorkflowForThreadV3({ db, threadId: testThreadId }),
    ).resolves.toEqual(
      expect.objectContaining({
        workflow: expect.objectContaining({ id: orphan.id }),
        head: expect.objectContaining({ workflowId: orphan.id }),
      }),
    );
  });
});

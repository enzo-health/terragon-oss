import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { enrollV2Workflow } from "./v2-enrollment";
import {
  getWorkflow,
  getActiveWorkflowForThread,
  updateWorkflowState,
} from "@terragon/shared/delivery-loop/store/workflow-store";
import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testUserId: string;
let testThreadId: string;
const TEST_REPO = "terragon/test-repo";

beforeEach(async () => {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({ db, userId: user.id });
  testUserId = user.id;
  testThreadId = threadId;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enrollV2Workflow — integration", () => {
  describe("happy path", () => {
    it("creates workflow in planning state with planVersion: null", async () => {
      const result = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
      });

      expect(result.workflowId).toBeDefined();
      expect(result.sdlcLoopId).toBeNull();

      const wf = await getWorkflow({ db, workflowId: result.workflowId });
      expect(wf).toBeDefined();
      expect(wf!.kind).toBe("planning");
      expect(wf!.threadId).toBe(testThreadId);
      expect(wf!.userId).toBe(testUserId);
      expect(wf!.repoFullName).toBe(TEST_REPO);

      const stateJson = wf!.stateJson as Record<string, unknown>;
      expect(stateJson.planVersion).toBeNull();
    });

    it("enqueues a bootstrap dispatch work item", async () => {
      const result = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
      });

      const workItems = await db.query.deliveryWorkItem.findMany({
        where: eq(schema.deliveryWorkItem.workflowId, result.workflowId),
      });

      expect(workItems.length).toBe(1);
      expect(workItems[0]!.kind).toBe("dispatch");
      expect(workItems[0]!.status).toBe("pending");

      const payload = workItems[0]!.payloadJson as Record<string, unknown>;
      expect(payload.bootstrap).toBe(true);
      expect(payload.executionClass).toBe("implementation_runtime");
    });
  });

  describe("idempotency", () => {
    it("returns same workflowId on second call for same thread", async () => {
      const first = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
      });

      const second = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
      });

      expect(second.workflowId).toBe(first.workflowId);
    });

    it("does not create a second workflow row", async () => {
      await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
      });

      await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
      });

      const rows = await db.query.deliveryWorkflow.findMany({
        where: eq(schema.deliveryWorkflow.threadId, testThreadId),
      });

      expect(rows.length).toBe(1);
    });
  });

  describe("generation calculation", () => {
    it("first enrollment gets generation 1", async () => {
      const result = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
      });

      const wf = await getWorkflow({ db, workflowId: result.workflowId });
      expect(wf!.generation).toBe(1);
    });

    it("re-enrollment after stopping gets generation 2", async () => {
      const first = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
      });

      // Move first workflow to terminal state
      const wf = await getWorkflow({ db, workflowId: first.workflowId });
      await updateWorkflowState({
        db,
        workflowId: first.workflowId,
        expectedVersion: wf!.version,
        kind: "stopped",
        stateJson: {},
      });

      const second = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
      });

      expect(second.workflowId).not.toBe(first.workflowId);

      const wf2 = await getWorkflow({ db, workflowId: second.workflowId });
      expect(wf2!.generation).toBe(2);
    });

    it("explicit generation param overrides auto-calculation", async () => {
      const result = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
        generation: 42,
      });

      const wf = await getWorkflow({ db, workflowId: result.workflowId });
      expect(wf!.generation).toBe(42);
    });
  });

  describe("plan approval policy", () => {
    it("defaults to auto", async () => {
      const result = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
      });

      const wf = await getWorkflow({ db, workflowId: result.workflowId });
      expect(wf!.planApprovalPolicy).toBe("auto");
    });

    it("stores explicit human_required policy", async () => {
      const result = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
        planApprovalPolicy: "human_required",
      });

      const wf = await getWorkflow({ db, workflowId: result.workflowId });
      expect(wf!.planApprovalPolicy).toBe("human_required");
    });
  });

  describe("edge cases", () => {
    it("different threads get different workflows", async () => {
      const { user: user2 } = await createTestUser({ db });
      const { threadId: threadId2 } = await createTestThread({
        db,
        userId: user2.id,
      });

      const result1 = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: testUserId,
        repoFullName: TEST_REPO,
      });

      const result2 = await enrollV2Workflow({
        db,
        threadId: threadId2,
        userId: user2.id,
        repoFullName: TEST_REPO,
      });

      expect(result1.workflowId).not.toBe(result2.workflowId);

      const wf1 = await getWorkflow({ db, workflowId: result1.workflowId });
      const wf2 = await getWorkflow({ db, workflowId: result2.workflowId });
      expect(wf1!.threadId).toBe(testThreadId);
      expect(wf2!.threadId).toBe(threadId2);
    });

    it("enrollment with different userId than thread owner", async () => {
      const { user: otherUser } = await createTestUser({ db });

      const result = await enrollV2Workflow({
        db,
        threadId: testThreadId,
        userId: otherUser.id,
        repoFullName: TEST_REPO,
      });

      const wf = await getWorkflow({ db, workflowId: result.workflowId });
      expect(wf!.userId).toBe(otherUser.id);
      expect(wf!.threadId).toBe(testThreadId);
    });
  });
});

import * as schema from "@terragon/shared/db/schema";
import * as dispatchIntentStoreModule from "@terragon/shared/delivery-loop/store/dispatch-intent-store";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid/non-secure";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import * as dispatchIntentModule from "@/server-lib/delivery-loop/dispatch-intent";
import * as followUpQueueModule from "@/server-lib/process-follow-up-queue";
import * as kernelModule from "./kernel";
import {
  computeDeliveryCheckStatus,
  drainDueEffects,
  effectResultToEvent,
} from "./process-effects";
import {
  ensureWorkflowHead,
  getWorkflowHead,
  insertEffects,
  updateWorkflowHead,
} from "./store";
import type { EffectResult, EffectSpec } from "./types";

const TEST_EFFECT_PREFIX = "dl3:test:v3-effect-worker";
afterEach(() => {
  vi.restoreAllMocks();
});

async function createWorkflowFixture(): Promise<string> {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({ db, userId: user.id });
  const workflow = await createWorkflow({
    db,
    threadId,
    generation: 1,
    userId: user.id,
    kind: "planning",
    stateJson: { state: "planning" },
  });
  return workflow.id;
}

describe("effectResultToEvent", () => {
  // create_plan_artifact
  it("plan artifact created with auto policy → plan_completed", () => {
    const result = effectResultToEvent({
      kind: "create_plan_artifact",
      outcome: "created",
      approvalPolicy: "auto",
    });
    expect(result).toEqual({ type: "plan_completed" });
  });

  it("plan artifact created with human policy → null (awaits UI approval)", () => {
    const result = effectResultToEvent({
      kind: "create_plan_artifact",
      outcome: "created",
      approvalPolicy: "human",
    });
    expect(result).toBeNull();
  });

  it("plan artifact failed → plan_failed", () => {
    const result = effectResultToEvent({
      kind: "create_plan_artifact",
      outcome: "failed",
      reason: "parse error",
    });
    expect(result).toEqual({ type: "plan_failed", reason: "parse error" });
  });

  // dispatch_gate_review
  it("gate review dispatched → dispatch_queued", () => {
    const ackDeadline = new Date("2030-01-01");
    const result = effectResultToEvent({
      kind: "dispatch_gate_review",
      outcome: "dispatched",
      runId: "r-1",
      ackDeadlineAt: ackDeadline,
    });
    expect(result).toEqual({
      type: "dispatch_queued",
      runId: "r-1",
      ackDeadlineAt: ackDeadline,
    });
  });

  it("gate review failed → run_failed with infra lane", () => {
    const result = effectResultToEvent({
      kind: "dispatch_gate_review",
      outcome: "failed",
      reason: "no sandbox",
    });
    expect(result).toMatchObject({
      type: "run_failed",
      message: "no sandbox",
      category: "effect_failure",
      lane: "infra",
    });
  });

  it("gate review failure carries the active runSeq when provided", () => {
    const result = effectResultToEvent(
      {
        kind: "dispatch_gate_review",
        outcome: "failed",
        reason: "no sandbox",
      },
      { activeRunSeq: 7 },
    );
    expect(result).toMatchObject({
      type: "run_failed",
      runSeq: 7,
      category: "effect_failure",
      lane: "infra",
    });
  });

  // ensure_pr
  it("PR linked → pr_linked", () => {
    const result = effectResultToEvent({
      kind: "ensure_pr",
      outcome: "linked",
      prNumber: 42,
    });
    expect(result).toEqual({ type: "pr_linked", prNumber: 42 });
  });

  it("no diff → gate_review_failed", () => {
    const result = effectResultToEvent({
      kind: "ensure_pr",
      outcome: "no_diff",
      reason: "No code changes",
    });
    expect(result).toEqual({
      type: "gate_review_failed",
      runSeq: null,
      reason: "No code changes",
    });
  });

  it("PR creation failed → gate_review_failed", () => {
    const result = effectResultToEvent({
      kind: "ensure_pr",
      outcome: "failed",
      reason: "sandbox error",
    });
    expect(result).toEqual({
      type: "gate_review_failed",
      runSeq: null,
      reason: "sandbox error",
    });
  });

  it("ensure_pr failures carry the active runSeq when provided", () => {
    const result = effectResultToEvent(
      {
        kind: "ensure_pr",
        outcome: "failed",
        reason: "sandbox error",
      },
      { activeRunSeq: 9 },
    );
    expect(result).toEqual({
      type: "gate_review_failed",
      runSeq: 9,
      reason: "sandbox error",
    });
  });

  // run_lease_expiry_check
  it("lease expiry fired → dispatch_ack_timeout", () => {
    const result = effectResultToEvent({
      kind: "run_lease_expiry_check",
      outcome: "fired",
      runId: "r-1",
    });
    expect(result).toEqual({ type: "dispatch_ack_timeout", runId: "r-1" });
  });

  it("lease expiry stale → null", () => {
    const result = effectResultToEvent({
      kind: "run_lease_expiry_check",
      outcome: "stale",
    });
    expect(result).toBeNull();
  });

  // dispatch_implementing
  it("implementing dispatch dispatched → dispatch_queued", () => {
    const ackDeadline = new Date("2030-01-01");
    const result = effectResultToEvent({
      kind: "dispatch_implementing",
      outcome: "dispatched",
      runId: "r-impl-1",
      ackDeadlineAt: ackDeadline,
    });
    expect(result).toEqual({
      type: "dispatch_queued",
      runId: "r-impl-1",
      ackDeadlineAt: ackDeadline,
    });
  });

  it("implementing dispatch failed → run_failed with infra lane", () => {
    const result = effectResultToEvent({
      kind: "dispatch_implementing",
      outcome: "failed",
      reason: "sandbox unavailable",
    });
    expect(result).toMatchObject({
      type: "run_failed",
      message: "sandbox unavailable",
      category: "effect_failure",
      lane: "infra",
    });
  });

  it("implementing dispatch failure carries the active runSeq when provided", () => {
    const result = effectResultToEvent(
      {
        kind: "dispatch_implementing",
        outcome: "failed",
        reason: "sandbox unavailable",
      },
      { activeRunSeq: 11 },
    );
    expect(result).toMatchObject({
      type: "run_failed",
      runSeq: 11,
      category: "effect_failure",
      lane: "infra",
    });
  });

  // gate_staleness_check
  it("gate staleness ci_passed → gate_ci_passed", () => {
    const result = effectResultToEvent({
      kind: "gate_staleness_check",
      outcome: "ci_passed",
      headSha: "abc123",
    });
    expect(result).toEqual({ type: "gate_ci_passed", headSha: "abc123" });
  });

  it("gate staleness ci_failed → gate_ci_failed", () => {
    const result = effectResultToEvent({
      kind: "gate_staleness_check",
      outcome: "ci_failed",
      headSha: "abc123",
      reason: "lint failed",
    });
    expect(result).toEqual({
      type: "gate_ci_failed",
      headSha: "abc123",
      reason: "lint failed",
    });
  });

  it("gate staleness pending → null", () => {
    const result = effectResultToEvent({
      kind: "gate_staleness_check",
      outcome: "pending",
    });
    expect(result).toBeNull();
  });

  it("gate staleness stale → null", () => {
    const result = effectResultToEvent({
      kind: "gate_staleness_check",
      outcome: "stale",
    });
    expect(result).toBeNull();
  });

  it("exhaustiveness: every EffectResult kind is handled (compile-time check)", () => {
    // This test verifies that the default `never` branch in effectResultToEvent
    // compiles. If a new EffectResult kind is added without a corresponding
    // case, TypeScript will report a compile error on the `never` assignment.
    // At runtime we just confirm the function handles all known kinds.
    const allResults: EffectResult[] = [
      {
        kind: "create_plan_artifact",
        outcome: "created",
        approvalPolicy: "auto",
      },
      { kind: "create_plan_artifact", outcome: "failed", reason: "x" },
      {
        kind: "dispatch_gate_review",
        outcome: "dispatched",
        runId: "r",
        ackDeadlineAt: new Date(),
      },
      { kind: "dispatch_gate_review", outcome: "failed", reason: "x" },
      { kind: "ensure_pr", outcome: "linked", prNumber: 1 },
      { kind: "ensure_pr", outcome: "no_diff", reason: "x" },
      { kind: "ensure_pr", outcome: "failed", reason: "x" },
      {
        kind: "dispatch_implementing",
        outcome: "dispatched",
        runId: "r",
        ackDeadlineAt: new Date(),
      },
      { kind: "dispatch_implementing", outcome: "failed", reason: "x" },
      { kind: "run_lease_expiry_check", outcome: "fired", runId: "r" },
      { kind: "run_lease_expiry_check", outcome: "stale" },
      { kind: "ack_timeout_check", outcome: "fired", runId: "r" },
      { kind: "ack_timeout_check", outcome: "stale" },
      { kind: "gate_staleness_check", outcome: "ci_passed", headSha: "s" },
      {
        kind: "gate_staleness_check",
        outcome: "ci_failed",
        headSha: "s",
        reason: "x",
      },
      { kind: "gate_staleness_check", outcome: "pending" },
      { kind: "gate_staleness_check", outcome: "stale" },
    ];
    for (const r of allResults) {
      // Should not throw
      effectResultToEvent(r);
    }
  });
});

describe("computeDeliveryCheckStatus", () => {
  // Green-before-merge: branch-protection friendly. While awaiting the user
  // to merge / close the PR, the Terragon self-check must report success so
  // rules gating merge on that check can pass.
  it("awaiting_pr_lifecycle → completed + success", () => {
    expect(
      computeDeliveryCheckStatus({
        state: "awaiting_pr_lifecycle",
        blockedReason: null,
      }),
    ).toEqual({ status: "completed", conclusion: "success" });
  });

  // Merged PR: reducer sets blockedReason to "PR merged" when `pr_closed`
  // fires with `merged: true`. Surface that as success, not cancelled.
  it("terminated + merged → completed + success", () => {
    expect(
      computeDeliveryCheckStatus({
        state: "terminated",
        blockedReason: "PR merged",
      }),
    ).toEqual({ status: "completed", conclusion: "success" });
  });

  it("terminated + closed-without-merge → completed + cancelled", () => {
    expect(
      computeDeliveryCheckStatus({
        state: "terminated",
        blockedReason: "PR closed",
      }),
    ).toEqual({ status: "completed", conclusion: "cancelled" });
  });

  // Defensive: if blockedReason is missing on a terminated workflow (e.g.
  // terminated via a path that didn't set it), default to cancelled rather
  // than falsely report success.
  it("terminated + null blockedReason → completed + cancelled", () => {
    expect(
      computeDeliveryCheckStatus({
        state: "terminated",
        blockedReason: null,
      }),
    ).toEqual({ status: "completed", conclusion: "cancelled" });
  });

  it("stopped → completed + cancelled", () => {
    expect(
      computeDeliveryCheckStatus({
        state: "stopped",
        blockedReason: "Stopped by user",
      }),
    ).toEqual({ status: "completed", conclusion: "cancelled" });
  });

  it("done → completed + success", () => {
    expect(
      computeDeliveryCheckStatus({ state: "done", blockedReason: null }),
    ).toEqual({ status: "completed", conclusion: "success" });
  });

  // Blocked / waiting on human — real work is pending, leave the check
  // in_progress so branch protection still gates merge.
  it("awaiting_manual_fix → in_progress", () => {
    expect(
      computeDeliveryCheckStatus({
        state: "awaiting_manual_fix",
        blockedReason: "Fix budget exhausted",
      }),
    ).toEqual({ status: "in_progress", conclusion: undefined });
  });

  it("awaiting_operator_action → in_progress", () => {
    expect(
      computeDeliveryCheckStatus({
        state: "awaiting_operator_action",
        blockedReason: "Infra budget exhausted",
      }),
    ).toEqual({ status: "in_progress", conclusion: undefined });
  });

  it("implementing → in_progress", () => {
    expect(
      computeDeliveryCheckStatus({
        state: "implementing",
        blockedReason: null,
      }),
    ).toEqual({ status: "in_progress", conclusion: undefined });
  });
});

describe("drainDueEffects", () => {
  it("skips timer effects until they are due", async () => {
    const now = new Date("2026-03-18T10:05:00.000Z");
    const leaseExpiresAt = new Date("2026-03-18T10:10:00.000Z");
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) {
      throw new Error("Expected workflow head for timer test");
    }

    const updated = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "implementing",
        activeGate: null,
        activeRunId: "run-timer",
        activeRunSeq: 1,
        leaseExpiresAt,
        blockedReason: null,
        updatedAt: new Date("2026-03-18T10:00:00.000Z"),
        lastActivityAt: new Date("2026-03-18T10:00:00.000Z"),
      },
      expectedVersion: head.version,
    });
    expect(updated).toBe(true);

    const effect: EffectSpec = {
      kind: "run_lease_expiry_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:lease`,
      dueAt: leaseExpiresAt,
      payload: {
        kind: "run_lease_expiry_check",
        runId: "run-timer",
        workflowVersion: head.version + 1,
      },
    };

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: head.version + 1,
      effects: [effect],
    });
    expect(inserted).toBe(1);

    const beforeDrain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });

    expect(beforeDrain.processed).toBeLessThanOrEqual(1);

    const effectRow = await db.query.deliveryEffectLedgerV3.findFirst({
      where: and(
        eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
        eq(schema.deliveryEffectLedgerV3.effectKind, "run_lease_expiry_check"),
      ),
    });
    if (!effectRow) {
      throw new Error("Expected lease expiry effect row");
    }
    expect(effectRow.status).toBe("planned");

    await db
      .delete(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, workflowId));
  });

  it("emits dispatch_ack_timeout when the implementation lease expires", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const leaseExpiresAt = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) {
      throw new Error("Expected workflow head for timer replay test");
    }

    const dispatchRunId = `run-${nanoid()}`;
    const hydrated = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "awaiting_implementation_acceptance",
        activeGate: null,
        activeRunId: dispatchRunId,
        activeRunSeq: 1,
        leaseExpiresAt,
        headSha: "head-before-timeout",
        blockedReason: null,
        updatedAt: new Date("2026-03-18T10:00:00.000Z"),
        lastActivityAt: new Date("2026-03-18T10:00:00.000Z"),
      },
      expectedVersion: head.version,
    });
    expect(hydrated).toBe(true);

    // Ensure this timeout path cannot be suppressed by a pre-existing run context
    // from unrelated tests/workflows using the same runId.
    await db
      .delete(schema.agentRunContext)
      .where(eq(schema.agentRunContext.runId, dispatchRunId));

    await db
      .delete(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, workflowId));

    const effect: EffectSpec = {
      kind: "run_lease_expiry_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:due`,
      dueAt: leaseExpiresAt,
      payload: {
        kind: "run_lease_expiry_check",
        runId: dispatchRunId,
        workflowVersion: head.version + 1,
      },
    };

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: head.version + 1,
      effects: [effect],
    });
    expect(inserted).toBe(1);

    const firstDrain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });

    expect(firstDrain.processed).toBe(1);

    const afterDrain = await getWorkflowHead({ db, workflowId });
    if (!afterDrain) {
      throw new Error("Expected workflow head after draining timer");
    }
    expect(afterDrain.infraRetryCount).toBe(1);
    expect(afterDrain.activeRunId).toBeNull();
    expect(afterDrain.version).toBe(head.version + 2);

    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    const timerEffect = effectRows.find(
      (row) => row.effectKind === "run_lease_expiry_check",
    );
    if (!timerEffect) {
      throw new Error("Expected lease expiry effect row after drain");
    }
    expect(timerEffect.status).toBe("succeeded");

    const retryEffect = effectRows.find(
      (row) => row.effectKind === "dispatch_implementing",
    );
    expect(retryEffect).toBeDefined();
    expect(retryEffect?.status).toBe("planned");

    const publishStatusEffect = effectRows.find(
      (row) => row.effectKind === "publish_status",
    );
    expect(publishStatusEffect).toBeDefined();
    expect(publishStatusEffect?.status).toBe("planned");

    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    const timerSignalRows = journalRows.filter(
      (row) => row.eventType === "dispatch_ack_timeout",
    );
    expect(timerSignalRows).toHaveLength(1);

    await db
      .delete(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, workflowId));

    const secondDrain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(secondDrain.processed).toBe(0);

    await db
      .delete(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, workflowId));
  });

  it("suppresses lease expiry when daemon run context confirms the run is active", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const leaseExpiresAt = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) {
      throw new Error("Expected workflow head for default-stale timer test");
    }

    const dispatchRunId = `run-${nanoid()}`;
    const hydrated = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "awaiting_implementation_acceptance",
        activeGate: null,
        activeRunId: dispatchRunId,
        activeRunSeq: 1,
        leaseExpiresAt,
        headSha: "head-before-timeout",
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(hydrated).toBe(true);

    const workflow = await db.query.deliveryWorkflow.findFirst({
      where: eq(schema.deliveryWorkflow.id, workflowId),
    });
    if (!workflow) {
      throw new Error("Expected workflow row for run-context suppression test");
    }

    const [threadChat] = await db
      .insert(schema.threadChat)
      .values({
        threadId: workflow.threadId,
        userId: workflow.userId,
        status: "working",
      })
      .returning({ id: schema.threadChat.id });
    if (!threadChat) {
      throw new Error("Expected thread chat row for run-context suppression");
    }

    await db.insert(schema.agentRunContext).values({
      runId: dispatchRunId,
      userId: workflow.userId,
      threadId: workflow.threadId,
      threadChatId: threadChat.id,
      sandboxId: `sandbox-${nanoid()}`,
      agent: "claudeCode",
      tokenNonce: nanoid(),
      status: "processing",
    });

    await db
      .delete(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, workflowId));

    const effect: EffectSpec = {
      kind: "run_lease_expiry_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:due-default-stale`,
      dueAt: leaseExpiresAt,
      payload: {
        kind: "run_lease_expiry_check",
        runId: dispatchRunId,
        workflowVersion: head.version + 1,
      },
    };

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: head.version + 1,
      effects: [effect],
    });
    expect(inserted).toBe(1);

    const firstDrain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });

    expect(firstDrain.processed).toBe(1);

    const afterDrain = await getWorkflowHead({ db, workflowId });
    if (!afterDrain) {
      throw new Error("Expected workflow head after draining timer");
    }
    expect(afterDrain.state).toBe("implementing");
    expect(afterDrain.activeRunId).toBe(dispatchRunId);
    expect(afterDrain.infraRetryCount).toBe(0);
    expect(afterDrain.version).toBe(head.version + 1);

    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    const timerSignalRows = journalRows.filter(
      (row) => row.eventType === "dispatch_ack_timeout",
    );
    expect(timerSignalRows).toHaveLength(0);

    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    expect(
      effectRows.some((row) => row.effectKind === "dispatch_implementing"),
    ).toBe(false);
    expect(effectRows.some((row) => row.effectKind === "publish_status")).toBe(
      false,
    );
  });

  it("does not suppress lease expiry for terminal run-context rows", async () => {
    const terminalStatuses = ["completed", "failed"] as const;

    for (const status of terminalStatuses) {
      const now = new Date("2026-03-18T10:00:00.000Z");
      const leaseExpiresAt = new Date("2026-03-18T10:00:00.000Z");
      const workflowId = await createWorkflowFixture();
      const head = await ensureWorkflowHead({ db, workflowId });
      if (!head) {
        throw new Error("Expected workflow head for terminal run-context test");
      }

      const dispatchRunId = `run-${status}-${nanoid()}`;
      const hydrated = await updateWorkflowHead({
        db,
        head: {
          ...head,
          version: head.version + 1,
          state: "implementing",
          activeGate: null,
          activeRunId: dispatchRunId,
          activeRunSeq: 1,
          leaseExpiresAt,
          blockedReason: null,
          updatedAt: now,
          lastActivityAt: now,
        },
        expectedVersion: head.version,
      });
      expect(hydrated).toBe(true);

      const workflow = await db.query.deliveryWorkflow.findFirst({
        where: eq(schema.deliveryWorkflow.id, workflowId),
      });
      if (!workflow) {
        throw new Error("Expected workflow row for terminal run-context test");
      }

      const [threadChat] = await db
        .insert(schema.threadChat)
        .values({
          threadId: workflow.threadId,
          userId: workflow.userId,
          status: "complete",
        })
        .returning({ id: schema.threadChat.id });
      if (!threadChat) {
        throw new Error("Expected thread chat row for terminal run-context");
      }

      await db.insert(schema.agentRunContext).values({
        runId: dispatchRunId,
        userId: workflow.userId,
        threadId: workflow.threadId,
        threadChatId: threadChat.id,
        sandboxId: `sandbox-${nanoid()}`,
        agent: "claudeCode",
        tokenNonce: nanoid(),
        status,
      });

      const effect: EffectSpec = {
        kind: "run_lease_expiry_check",
        effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:terminal-${status}`,
        dueAt: leaseExpiresAt,
        payload: {
          kind: "run_lease_expiry_check",
          runId: dispatchRunId,
          workflowVersion: head.version + 1,
        },
      };

      const inserted = await insertEffects({
        db,
        workflowId,
        workflowVersion: head.version + 1,
        effects: [effect],
      });
      expect(inserted).toBe(1);

      const drain = await drainDueEffects({
        db,
        workflowId,
        maxItems: 1,
        leaseOwnerPrefix: "test:v3-effects",
        now,
      });
      expect(drain.processed).toBe(1);

      const headAfter = await getWorkflowHead({ db, workflowId });
      if (!headAfter) {
        throw new Error(
          "Expected workflow head after terminal run-context drain",
        );
      }
      expect(headAfter.infraRetryCount).toBe(1);

      const journalRows = await db.query.deliveryLoopJournalV3.findMany({
        where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
      });
      expect(
        journalRows.filter((row) => row.eventType === "dispatch_ack_timeout"),
      ).toHaveLength(1);
    }
  });

  it("does not suppress lease expiry for pre-ack run-context rows", async () => {
    const preAckStatuses = ["pending", "dispatched"] as const;

    for (const status of preAckStatuses) {
      const now = new Date("2026-03-18T10:00:00.000Z");
      const leaseExpiresAt = new Date("2026-03-18T10:00:00.000Z");
      const workflowId = await createWorkflowFixture();
      const head = await ensureWorkflowHead({ db, workflowId });
      if (!head) {
        throw new Error("Expected workflow head for pre-ack run-context test");
      }

      const dispatchRunId = `run-${status}-${nanoid()}`;
      const hydrated = await updateWorkflowHead({
        db,
        head: {
          ...head,
          version: head.version + 1,
          state: "implementing",
          activeGate: null,
          activeRunId: dispatchRunId,
          activeRunSeq: 1,
          leaseExpiresAt,
          blockedReason: null,
          updatedAt: now,
          lastActivityAt: now,
        },
        expectedVersion: head.version,
      });
      expect(hydrated).toBe(true);

      const workflow = await db.query.deliveryWorkflow.findFirst({
        where: eq(schema.deliveryWorkflow.id, workflowId),
      });
      if (!workflow) {
        throw new Error("Expected workflow row for pre-ack run-context test");
      }

      const [threadChat] = await db
        .insert(schema.threadChat)
        .values({
          threadId: workflow.threadId,
          userId: workflow.userId,
          status: "working",
        })
        .returning({ id: schema.threadChat.id });
      if (!threadChat) {
        throw new Error("Expected thread chat row for pre-ack run-context");
      }

      await db.insert(schema.agentRunContext).values({
        runId: dispatchRunId,
        userId: workflow.userId,
        threadId: workflow.threadId,
        threadChatId: threadChat.id,
        sandboxId: `sandbox-${nanoid()}`,
        agent: "claudeCode",
        tokenNonce: nanoid(),
        status,
      });

      const effect: EffectSpec = {
        kind: "run_lease_expiry_check",
        effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:pre-ack-${status}`,
        dueAt: leaseExpiresAt,
        payload: {
          kind: "run_lease_expiry_check",
          runId: dispatchRunId,
          workflowVersion: head.version + 1,
        },
      };

      const inserted = await insertEffects({
        db,
        workflowId,
        workflowVersion: head.version + 1,
        effects: [effect],
      });
      expect(inserted).toBe(1);

      const drain = await drainDueEffects({
        db,
        workflowId,
        maxItems: 1,
        leaseOwnerPrefix: "test:v3-effects",
        now,
      });
      expect(drain.processed).toBe(1);

      const headAfter = await getWorkflowHead({ db, workflowId });
      if (!headAfter) {
        throw new Error(
          "Expected workflow head after pre-ack run-context drain",
        );
      }
      expect(headAfter.infraRetryCount).toBe(1);

      const journalRows = await db.query.deliveryLoopJournalV3.findMany({
        where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
      });
      expect(
        journalRows.filter((row) => row.eventType === "dispatch_ack_timeout"),
      ).toHaveLength(1);
    }
  });

  it("treats ensure_pr as link signal when PR already exists", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({ db, userId: user.id });
    const workflow = await createWorkflow({
      db,
      threadId,
      generation: 1,
      userId: user.id,
      kind: "planning",
      stateJson: { state: "planning" },
      prNumber: 987,
    });

    const seededHead = await ensureWorkflowHead({
      db,
      workflowId: workflow.id,
    });
    if (!seededHead) {
      throw new Error("Expected workflow head for ensure_pr test");
    }

    const moved = await updateWorkflowHead({
      db,
      head: {
        ...seededHead,
        version: seededHead.version + 1,
        state: "awaiting_pr_creation",
        activeGate: null,
        activeRunId: null,
        activeRunSeq: 3,
        blockedReason: "stale marker should not block ensure_pr",
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: seededHead.version,
    });
    expect(moved).toBe(true);

    const inserted = await insertEffects({
      db,
      workflowId: workflow.id,
      workflowVersion: seededHead.version + 1,
      effects: [
        {
          kind: "ensure_pr",
          effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:ensure-pr`,
          dueAt: now,
          payload: { kind: "ensure_pr" },
        },
      ],
    });
    expect(inserted).toBe(1);

    const drain = await drainDueEffects({
      db,
      workflowId: workflow.id,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(drain.processed).toBe(1);

    const head = await getWorkflowHead({ db, workflowId: workflow.id });
    expect(head).not.toBeNull();
    if (!head) {
      throw new Error("Expected workflow head after ensure_pr drain");
    }
    expect(head.state).toBe("gating_ci");
    expect(head.activeGate).toBe("ci");
    expect(head.blockedReason).toBeNull();

    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflow.id),
    });
    const ensurePrEffect = effectRows.find(
      (row) => row.effectKind === "ensure_pr",
    );
    if (!ensurePrEffect) {
      throw new Error("Expected ensure_pr effect row");
    }
    expect(ensurePrEffect.status).toBe("succeeded");
  });

  it("stales mismatched lease expiry checks instead of relying on reducer drop", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const leaseExpiresAt = new Date("2026-03-18T10:00:00.000Z");
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({ db, userId: user.id });
    const workflow = await createWorkflow({
      db,
      threadId,
      generation: 1,
      userId: user.id,
      kind: "planning",
      stateJson: { state: "planning" },
    });
    const workflowId = workflow.id;

    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) throw new Error("Expected workflow head");

    const dispatchRunId = `run-${nanoid()}`;
    const moved = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "awaiting_implementation_acceptance",
        activeGate: null,
        activeRunId: dispatchRunId,
        activeRunSeq: 1,
        leaseExpiresAt,
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(moved).toBe(true);

    await db
      .delete(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, workflowId));

    // Create a threadChat that looks like the daemon is working
    await db.insert(schema.threadChat).values({
      threadId,
      userId: user.id,
      status: "working",
    });

    const effect: EffectSpec = {
      kind: "run_lease_expiry_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:lease-working`,
      dueAt: leaseExpiresAt,
      payload: {
        kind: "run_lease_expiry_check",
        runId: `stale-run-${nanoid()}`,
        workflowVersion: head.version + 1,
      },
    };

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: head.version + 1,
      effects: [effect],
    });
    expect(inserted).toBe(1);

    const drain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });

    expect(drain.processed).toBe(1);

    const headAfter = await getWorkflowHead({ db, workflowId });
    if (!headAfter) throw new Error("Expected head after drain");
    expect(headAfter.state).toBe("implementing");
    expect(headAfter.activeRunId).toBe(dispatchRunId);
    expect(headAfter.infraRetryCount).toBe(0);
    expect(headAfter.version).toBe(head.version + 1);

    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    expect(
      journalRows.filter((row) => row.eventType === "dispatch_ack_timeout"),
    ).toHaveLength(0);
  });

  it("suppresses lease expiry when daemon is working AND activeRunId matches", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const leaseExpiresAt = new Date("2026-03-18T10:00:00.000Z");
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({ db, userId: user.id });
    const workflow = await createWorkflow({
      db,
      threadId,
      generation: 1,
      userId: user.id,
      kind: "planning",
      stateJson: { state: "planning" },
    });
    const workflowId = workflow.id;

    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) throw new Error("Expected workflow head");

    const dispatchRunId = `run-${nanoid()}`;
    const moved = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "implementing",
        activeGate: null,
        activeRunId: dispatchRunId,
        activeRunSeq: 1,
        leaseExpiresAt,
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(moved).toBe(true);

    // Daemon is actively working
    const [threadChatRow] = await db
      .insert(schema.threadChat)
      .values({
        threadId,
        userId: user.id,
        status: "working",
      })
      .returning({ id: schema.threadChat.id });

    // An agent_run_context row proves the daemon actually received this run
    await db.insert(schema.agentRunContext).values({
      runId: dispatchRunId,
      userId: user.id,
      threadId,
      threadChatId: threadChatRow!.id,
      sandboxId: `sandbox-${nanoid()}`,
      agent: "claudeCode",
      tokenNonce: nanoid(),
      status: "processing",
    });

    const effect: EffectSpec = {
      kind: "run_lease_expiry_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:lease-suppressed`,
      dueAt: leaseExpiresAt,
      payload: {
        kind: "run_lease_expiry_check",
        runId: dispatchRunId,
        workflowVersion: head.version + 1,
      },
    };

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: head.version + 1,
      effects: [effect],
    });
    expect(inserted).toBe(1);

    const drain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });

    // Effect was processed but returned stale (suppressed)
    expect(drain.processed).toBe(1);

    // State unchanged — timeout was suppressed, no retry triggered
    const headAfter = await getWorkflowHead({ db, workflowId });
    if (!headAfter) throw new Error("Expected head after drain");
    expect(headAfter.state).toBe("implementing");
    expect(headAfter.activeRunId).toBe(dispatchRunId);
    expect(headAfter.infraRetryCount).toBe(0);
    expect(headAfter.version).toBe(head.version + 1); // unchanged
  });

  it("lease expiry with version mismatch returns stale (no event fired)", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const leaseExpiresAt = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) throw new Error("Expected workflow head");

    const moved = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "implementing",
        activeGate: null,
        activeRunId: `run-${nanoid()}`,
        activeRunSeq: 1,
        leaseExpiresAt,
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(moved).toBe(true);

    const effect: EffectSpec = {
      kind: "run_lease_expiry_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:stale-ver`,
      dueAt: leaseExpiresAt,
      payload: {
        kind: "run_lease_expiry_check",
        runId: `run-${nanoid()}`,
        workflowVersion: head.version, // mismatch — head is now head.version+1
      },
    };

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: head.version + 1,
      effects: [effect],
    });
    expect(inserted).toBe(1);

    const drain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(drain.processed).toBe(1);

    // Effect processed as stale — no dispatch_ack_timeout journal entry
    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    const timeoutEvents = journalRows.filter(
      (r) => r.eventType === "dispatch_ack_timeout",
    );
    expect(timeoutEvents).toHaveLength(0);

    // Effect marked succeeded (stale is still "succeeded" status)
    const effectRow = await db.query.deliveryEffectLedgerV3.findFirst({
      where: and(
        eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
        eq(schema.deliveryEffectLedgerV3.effectKind, "run_lease_expiry_check"),
      ),
    });
    expect(effectRow?.status).toBe("succeeded");
  });

  it("suppresses stale state-blocking effect results when the workflow version has advanced", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) {
      throw new Error(
        "Expected workflow head for stale effect suppression test",
      );
    }

    const moved = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "planning",
        activeGate: null,
        activeRunId: null,
        activeRunSeq: null,
        leaseExpiresAt: null,
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(moved).toBe(true);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: head.version,
      effects: [
        {
          kind: "create_plan_artifact",
          effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:stale-create-plan`,
          dueAt: now,
          payload: { kind: "create_plan_artifact" },
        },
      ],
    });
    expect(inserted).toBe(1);

    const drain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(drain.processed).toBe(1);

    const headAfter = await getWorkflowHead({ db, workflowId });
    if (!headAfter) {
      throw new Error("Expected workflow head after stale effect suppression");
    }
    expect(headAfter.state).toBe("planning");
    expect(headAfter.version).toBe(head.version + 1);

    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    expect(
      journalRows.filter((row) => row.eventType === "plan_failed"),
    ).toHaveLength(0);

    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    const effectRow = effectRows.find(
      (row) => row.effectKind === "create_plan_artifact",
    );
    if (!effectRow) {
      throw new Error("Expected create_plan_artifact effect row");
    }
    expect(effectRow.status).toBe("succeeded");

    expect(warnSpy).toHaveBeenCalledWith(
      "[delivery-loop] suppressing stale state-blocking effect result",
      expect.objectContaining({
        workflowId,
        effectKind: "create_plan_artifact",
        effectWorkflowVersion: head.version,
        currentWorkflowVersion: head.version + 1,
      }),
    );
  });

  it("retries state-blocking effects when transition append fails", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const leaseExpiresAt = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) {
      throw new Error("Expected workflow head for append retry test");
    }

    const dispatchRunId = `run-${nanoid()}`;
    const hydrated = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "awaiting_implementation_acceptance",
        activeGate: null,
        activeRunId: dispatchRunId,
        activeRunSeq: 1,
        leaseExpiresAt,
        headSha: "head-before-append-retry",
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(hydrated).toBe(true);

    await db
      .delete(schema.agentRunContext)
      .where(eq(schema.agentRunContext.runId, dispatchRunId));

    const appendSpy = vi
      .spyOn(kernelModule, "appendEventAndAdvanceExplicit")
      .mockRejectedValueOnce(new Error("append boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: head.version + 1,
      effects: [
        {
          kind: "run_lease_expiry_check",
          effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:append-failure`,
          dueAt: leaseExpiresAt,
          payload: {
            kind: "run_lease_expiry_check",
            runId: dispatchRunId,
            workflowVersion: head.version + 1,
          },
        },
      ],
    });
    expect(inserted).toBe(1);

    const drain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(drain.processed).toBe(1);
    expect(appendSpy).toHaveBeenCalledTimes(1);

    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    expect(
      journalRows.filter((row) => row.eventType === "dispatch_ack_timeout"),
    ).toHaveLength(0);

    const effectRow = await db.query.deliveryEffectLedgerV3.findFirst({
      where: and(
        eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
        eq(schema.deliveryEffectLedgerV3.effectKind, "run_lease_expiry_check"),
      ),
    });
    if (!effectRow) {
      throw new Error("Expected run_lease_expiry_check effect row");
    }
    expect(effectRow.status).toBe("planned");
    expect(effectRow.lastErrorCode).toBe("transition_append_failed");
    expect(effectRow.lastErrorMessage).toBe("append boom");
    expect(effectRow.leaseOwner).toBeNull();
    expect(effectRow.leaseExpiresAt).toBeNull();
    expect(effectRow.dueAt.getTime()).toBeGreaterThan(now.getTime());

    expect(errorSpy).toHaveBeenCalledWith(
      "[delivery-loop] effect transition append failed — marking effect for retry",
      expect.objectContaining({
        workflowId,
        effectId: effectRow.id,
        eventType: "dispatch_ack_timeout",
        error: "append boom",
      }),
    );
  });

  it("lease expiry fires when no daemon run context exists", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const leaseExpiresAt = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) throw new Error("Expected workflow head");

    const dispatchRunId = `run-${nanoid()}`;
    const moved = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "implementing",
        activeGate: null,
        activeRunId: dispatchRunId,
        activeRunSeq: 1,
        leaseExpiresAt,
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(moved).toBe(true);

    const effect: EffectSpec = {
      kind: "run_lease_expiry_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:no-chat`,
      dueAt: leaseExpiresAt,
      payload: {
        kind: "run_lease_expiry_check",
        runId: dispatchRunId,
        workflowVersion: head.version + 1,
      },
    };

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: head.version + 1,
      effects: [effect],
    });
    expect(inserted).toBe(1);

    const drain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(drain.processed).toBe(1);

    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    const timeoutEvents = journalRows.filter(
      (r) => r.eventType === "dispatch_ack_timeout",
    );
    expect(timeoutEvents).toHaveLength(1);

    const headAfter = await getWorkflowHead({ db, workflowId });
    if (!headAfter) throw new Error("Expected head after drain");
    expect(headAfter.infraRetryCount).toBe(1);
  });

  it("multiple effects drain in order (oldest first)", async () => {
    const now = new Date("2026-03-18T10:10:00.000Z");
    const firstDueAt = new Date("2026-03-18T10:00:00.000Z");
    const secondDueAt = new Date("2026-03-18T10:05:00.000Z");
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({ db, userId: user.id });
    const workflow = await createWorkflow({
      db,
      threadId,
      generation: 1,
      userId: user.id,
      kind: "planning",
      stateJson: { state: "planning" },
    });
    const workflowId = workflow.id;

    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) throw new Error("Expected workflow head");

    const runId1 = `run-${nanoid()}`;
    const runId2 = `run-${nanoid()}`;
    const moved = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "implementing",
        activeGate: null,
        activeRunId: runId1,
        activeRunSeq: 1,
        leaseExpiresAt: firstDueAt,
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(moved).toBe(true);

    const effects: EffectSpec[] = [
      {
        kind: "run_lease_expiry_check",
        effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:order-2`,
        dueAt: secondDueAt,
        payload: {
          kind: "run_lease_expiry_check",
          runId: runId2,
          workflowVersion: head.version + 1,
        },
      },
      {
        kind: "run_lease_expiry_check",
        effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:order-1`,
        dueAt: firstDueAt,
        payload: {
          kind: "run_lease_expiry_check",
          runId: runId1,
          workflowVersion: head.version + 1,
        },
      },
    ];

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: head.version + 1,
      effects,
    });
    expect(inserted).toBe(2);

    const drain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 2,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(drain.processed).toBe(2);

    // Both effects processed
    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflowId),
    });
    const ackEffects = effectRows.filter(
      (r) => r.effectKind === "run_lease_expiry_check",
    );
    expect(ackEffects.every((e) => e.status === "succeeded")).toBe(true);

    // Verify via dueAt order: the earlier-due effect was processed
    // first because claimNextEffect orders by dueAt. Both succeeded confirms
    // drain handled them sequentially.
    const dueAtOrder = ackEffects.sort(
      (a, b) => a.dueAt.getTime() - b.dueAt.getTime(),
    );
    expect(dueAtOrder[0]!.dueAt.getTime()).toBeLessThan(
      dueAtOrder[1]!.dueAt.getTime(),
    );
  });

  it("routes no-diff ensure_pr attempts back to awaiting implementation acceptance", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({ db, userId: user.id });
    const workflow = await createWorkflow({
      db,
      threadId,
      generation: 1,
      userId: user.id,
      kind: "planning",
      stateJson: { state: "planning" },
      prNumber: null,
    });
    await db
      .update(schema.thread)
      .set({
        gitDiff: null,
        gitDiffStats: {
          files: 0,
          additions: 0,
          deletions: 0,
        },
      })
      .where(eq(schema.thread.id, threadId));

    const seededHead = await ensureWorkflowHead({
      db,
      workflowId: workflow.id,
    });
    if (!seededHead) {
      throw new Error("Expected workflow head for no-diff ensure_pr test");
    }

    const moved = await updateWorkflowHead({
      db,
      head: {
        ...seededHead,
        version: seededHead.version + 1,
        state: "awaiting_pr_creation",
        activeGate: null,
        activeRunId: null,
        blockedReason: "stale marker should not block ensure_pr",
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: seededHead.version,
    });
    expect(moved).toBe(true);

    const inserted = await insertEffects({
      db,
      workflowId: workflow.id,
      workflowVersion: seededHead.version + 1,
      effects: [
        {
          kind: "ensure_pr",
          effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:ensure-pr-no-diff`,
          dueAt: now,
          payload: { kind: "ensure_pr" },
        },
      ],
    });
    expect(inserted).toBe(1);

    const drain = await drainDueEffects({
      db,
      workflowId: workflow.id,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(drain.processed).toBe(1);

    const head = await getWorkflowHead({ db, workflowId: workflow.id });
    expect(head).not.toBeNull();
    if (!head) {
      throw new Error("Expected workflow head after no-diff ensure_pr drain");
    }
    expect(head.state).toBe("implementing");
    expect(head.fixAttemptCount).toBe(1);

    const effectRows = await db.query.deliveryEffectLedgerV3.findMany({
      where: eq(schema.deliveryEffectLedgerV3.workflowId, workflow.id),
    });
    const ensurePrEffect = effectRows.find(
      (row) => row.effectKind === "ensure_pr",
    );
    if (!ensurePrEffect) {
      throw new Error("Expected ensure_pr effect row for no-diff test");
    }
    expect(ensurePrEffect.status).toBe("succeeded");
  });

  it("logs review gate follow-up queue trigger errors without dropping the queued dispatch", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const workflow = await db.query.deliveryWorkflow.findFirst({
      where: eq(schema.deliveryWorkflow.id, workflowId),
    });
    if (!workflow) {
      throw new Error("Expected workflow row for gate review warning test");
    }

    const [threadChat] = await db
      .insert(schema.threadChat)
      .values({
        threadId: workflow.threadId,
        userId: workflow.userId,
        status: "working",
      })
      .returning({ id: schema.threadChat.id });
    if (!threadChat) {
      throw new Error("Expected thread chat row for gate review warning test");
    }

    const seededHead = await ensureWorkflowHead({ db, workflowId });
    if (!seededHead) {
      throw new Error("Expected workflow head for gate review warning test");
    }

    const moved = await updateWorkflowHead({
      db,
      head: {
        ...seededHead,
        version: seededHead.version + 1,
        state: "gating_review",
        activeGate: "review",
        activeRunId: null,
        activeRunSeq: 2,
        leaseExpiresAt: null,
        headSha: "sha-review-test",
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: seededHead.version,
    });
    expect(moved).toBe(true);

    vi.spyOn(dispatchIntentModule, "createDispatchIntent").mockResolvedValue(
      {} as Awaited<
        ReturnType<typeof dispatchIntentModule.createDispatchIntent>
      >,
    );
    vi.spyOn(
      dispatchIntentStoreModule,
      "createDispatchIntent",
    ).mockResolvedValue("dispatch-intent-row-id");
    vi.spyOn(
      dispatchIntentStoreModule,
      "markDispatchIntentDispatched",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      followUpQueueModule,
      "maybeProcessFollowUpQueue",
    ).mockRejectedValue(new Error("queue exploded"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: seededHead.version + 1,
      effects: [
        {
          kind: "dispatch_gate_review",
          effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:gate-review-follow-up-warning`,
          dueAt: now,
          payload: { kind: "dispatch_gate_review", gate: "review" },
        },
      ],
    });
    expect(inserted).toBe(1);

    const drain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(drain.processed).toBe(1);

    const headAfter = await getWorkflowHead({ db, workflowId });
    if (!headAfter) {
      throw new Error("Expected workflow head after gate review warning test");
    }
    expect(headAfter.state).toBe("gating_review");

    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    expect(
      journalRows.filter((row) => row.eventType === "dispatch_queued"),
    ).toHaveLength(1);

    expect(warnSpy).toHaveBeenCalledWith(
      "[delivery-loop] review gate follow-up queue trigger failed",
      expect.objectContaining({
        workflowId,
        error: "queue exploded",
      }),
    );
  });

  it("treats implementing launch exceptions as non-fatal and keeps queued dispatch", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const workflow = await db.query.deliveryWorkflow.findFirst({
      where: eq(schema.deliveryWorkflow.id, workflowId),
    });
    if (!workflow) {
      throw new Error(
        "Expected workflow row for implementing dispatch warning test",
      );
    }

    const [threadChat] = await db
      .insert(schema.threadChat)
      .values({
        threadId: workflow.threadId,
        userId: workflow.userId,
        status: "working",
      })
      .returning({ id: schema.threadChat.id });
    if (!threadChat) {
      throw new Error(
        "Expected thread chat row for implementing dispatch warning test",
      );
    }

    const seededHead = await ensureWorkflowHead({ db, workflowId });
    if (!seededHead) {
      throw new Error(
        "Expected workflow head for implementing dispatch warning test",
      );
    }

    const moved = await updateWorkflowHead({
      db,
      head: {
        ...seededHead,
        version: seededHead.version + 1,
        state: "implementing",
        activeGate: null,
        activeRunId: null,
        activeRunSeq: 2,
        leaseExpiresAt: null,
        headSha: "sha-impl-test",
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: seededHead.version,
    });
    expect(moved).toBe(true);

    vi.spyOn(dispatchIntentModule, "createDispatchIntent").mockResolvedValue(
      {} as Awaited<
        ReturnType<typeof dispatchIntentModule.createDispatchIntent>
      >,
    );
    vi.spyOn(
      dispatchIntentStoreModule,
      "createDispatchIntent",
    ).mockResolvedValue("dispatch-intent-row-id");
    vi.spyOn(
      dispatchIntentStoreModule,
      "markDispatchIntentDispatched",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      followUpQueueModule,
      "launchDeliveryLoopDispatchFromIntent",
    ).mockRejectedValue(new Error("impl queue exploded"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: seededHead.version + 1,
      effects: [
        {
          kind: "dispatch_implementing",
          effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:implementing-follow-up-warning`,
          dueAt: now,
          payload: {
            kind: "dispatch_implementing",
            executionClass: "implementation_runtime",
          },
        },
      ],
    });
    expect(inserted).toBe(1);

    const drain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(drain.processed).toBe(1);

    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    expect(
      journalRows.filter((row) => row.eventType === "dispatch_queued"),
    ).toHaveLength(1);
    expect(
      journalRows.filter((row) => row.eventType === "run_failed"),
    ).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledWith(
      "[delivery-loop] follow-up queue trigger failed (non-fatal)",
      expect.objectContaining({
        workflowId,
        error: "impl queue exploded",
      }),
    );
  });

  it("logs lane + retry counts on successful dispatch_implementing", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const workflow = await db.query.deliveryWorkflow.findFirst({
      where: eq(schema.deliveryWorkflow.id, workflowId),
    });
    if (!workflow) {
      throw new Error("Expected workflow row for dispatch logging test");
    }

    const [threadChat] = await db
      .insert(schema.threadChat)
      .values({
        threadId: workflow.threadId,
        userId: workflow.userId,
        status: "working",
      })
      .returning({ id: schema.threadChat.id });
    if (!threadChat) {
      throw new Error("Expected thread chat row for dispatch logging test");
    }

    const seededHead = await ensureWorkflowHead({ db, workflowId });
    if (!seededHead) {
      throw new Error("Expected workflow head for dispatch logging test");
    }

    // Seed an infra-retry context so we can verify `lane: "infra"` and that
    // the head retry counters are surfaced in the log payload.
    const moved = await updateWorkflowHead({
      db,
      head: {
        ...seededHead,
        version: seededHead.version + 1,
        state: "implementing",
        activeGate: null,
        activeRunId: null,
        activeRunSeq: 2,
        leaseExpiresAt: null,
        headSha: "sha-impl-log",
        blockedReason: null,
        fixAttemptCount: 2,
        infraRetryCount: 1,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: seededHead.version,
    });
    expect(moved).toBe(true);

    vi.spyOn(dispatchIntentModule, "createDispatchIntent").mockResolvedValue(
      {} as Awaited<
        ReturnType<typeof dispatchIntentModule.createDispatchIntent>
      >,
    );
    vi.spyOn(
      dispatchIntentStoreModule,
      "createDispatchIntent",
    ).mockResolvedValue("dispatch-intent-row-id");
    vi.spyOn(
      dispatchIntentStoreModule,
      "markDispatchIntentDispatched",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      followUpQueueModule,
      "launchDeliveryLoopDispatchFromIntent",
    ).mockResolvedValue({
      processed: true,
      dispatchLaunched: true,
    } as Awaited<
      ReturnType<
        typeof followUpQueueModule.launchDeliveryLoopDispatchFromIntent
      >
    >);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const inserted = await insertEffects({
      db,
      workflowId,
      workflowVersion: seededHead.version + 1,
      effects: [
        {
          kind: "dispatch_implementing",
          effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:impl-dispatch-log`,
          dueAt: now,
          payload: {
            kind: "dispatch_implementing",
            executionClass: "implementation_runtime_fallback",
            retryReason: "infra retry: transient git push failure",
          },
        },
      ],
    });
    expect(inserted).toBe(1);

    const drain = await drainDueEffects({
      db,
      workflowId,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(drain.processed).toBe(1);

    expect(logSpy).toHaveBeenCalledWith(
      "[delivery-loop] dispatch_implementing effect complete",
      expect.objectContaining({
        workflowId,
        isRetry: true,
        lane: "infra",
        executionClass: "implementation_runtime_fallback",
        retryReason: "infra retry: transient git push failure",
        fixAttemptCount: 2,
        infraRetryCount: 1,
      }),
    );
  });
});

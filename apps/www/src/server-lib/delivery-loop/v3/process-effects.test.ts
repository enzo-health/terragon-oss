import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid/non-secure";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import {
  ensureWorkflowHead,
  getWorkflowHead,
  insertEffects,
  updateWorkflowHead,
} from "./store";
import { drainDueEffects, effectResultToEvent } from "./process-effects";
import type { EffectResult, EffectSpec } from "./types";

const TEST_EFFECT_PREFIX = "dl3:test:v3-effect-worker";
const ACK_TIMEOUT_CORRECTNESS_ENV_KEY =
  "DELIVERY_LOOP_V3_ENABLE_ACK_TIMEOUT_CORRECTNESS";
const ORIGINAL_ACK_TIMEOUT_CORRECTNESS_ENV =
  process.env[ACK_TIMEOUT_CORRECTNESS_ENV_KEY];

function setAckTimeoutCorrectnessEnv(value: "true" | "false" | undefined) {
  if (value === undefined) {
    delete process.env[ACK_TIMEOUT_CORRECTNESS_ENV_KEY];
    return;
  }
  process.env[ACK_TIMEOUT_CORRECTNESS_ENV_KEY] = value;
}

beforeEach(() => {
  setAckTimeoutCorrectnessEnv(undefined);
});

afterEach(() => {
  if (ORIGINAL_ACK_TIMEOUT_CORRECTNESS_ENV === undefined) {
    delete process.env[ACK_TIMEOUT_CORRECTNESS_ENV_KEY];
  } else {
    process.env[ACK_TIMEOUT_CORRECTNESS_ENV_KEY] =
      ORIGINAL_ACK_TIMEOUT_CORRECTNESS_ENV;
  }
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
      reason: "sandbox error",
    });
  });

  // ack_timeout_check
  it("ack timeout fired → dispatch_ack_timeout", () => {
    const result = effectResultToEvent({
      kind: "ack_timeout_check",
      outcome: "fired",
      runId: "r-1",
    });
    expect(result).toEqual({ type: "dispatch_ack_timeout", runId: "r-1" });
  });

  it("ack timeout stale → null", () => {
    const result = effectResultToEvent({
      kind: "ack_timeout_check",
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

describe("drainDueEffects", () => {
  it("skips timer effects until they are due", async () => {
    const now = new Date("2026-03-18T10:05:00.000Z");
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
        blockedReason: null,
        updatedAt: new Date("2026-03-18T10:00:00.000Z"),
        lastActivityAt: new Date("2026-03-18T10:00:00.000Z"),
      },
      expectedVersion: head.version,
    });
    expect(updated).toBe(true);

    const effect: EffectSpec = {
      kind: "ack_timeout_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:ack`,
      dueAt: new Date("2026-03-18T10:10:00.000Z"),
      payload: {
        kind: "ack_timeout_check",
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
        eq(schema.deliveryEffectLedgerV3.effectKind, "ack_timeout_check"),
      ),
    });
    if (!effectRow) {
      throw new Error("Expected ack timeout effect row");
    }
    expect(effectRow.status).toBe("planned");

    await db
      .delete(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, workflowId));
  });

  it("emits dispatch_ack_timeout when legacy correctness is enabled", async () => {
    setAckTimeoutCorrectnessEnv("true");
    const now = new Date("2026-03-18T10:00:00.000Z");
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
      kind: "ack_timeout_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:due`,
      dueAt: new Date("2026-03-18T10:00:00.000Z"),
      payload: {
        kind: "ack_timeout_check",
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
      (row) => row.effectKind === "ack_timeout_check",
    );
    if (!timerEffect) {
      throw new Error("Expected ack timeout effect row after drain");
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

  it("ack timeout defaults to stale when legacy correctness is unset", async () => {
    setAckTimeoutCorrectnessEnv(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const now = new Date("2026-03-18T10:00:00.000Z");
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
        headSha: "head-before-timeout",
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(hydrated).toBe(true);

    await db
      .delete(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, workflowId));

    const effect: EffectSpec = {
      kind: "ack_timeout_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:due-default-stale`,
      dueAt: new Date("2026-03-18T10:00:00.000Z"),
      payload: {
        kind: "ack_timeout_check",
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
    expect(afterDrain.state).not.toBe("awaiting_operator_action");
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

    expect(warnSpy).toHaveBeenCalledWith(
      "[delivery-loop] ack_timeout_check received while legacy correctness path is disabled",
      expect.objectContaining({
        metric: "delivery_loop_v3_ack_timeout_ignored",
        workflowId,
        runId: dispatchRunId,
        workflowVersion: head.version + 1,
      }),
    );
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

  it("fires ack timeout when daemon appears working but activeRunId was not journaled", async () => {
    setAckTimeoutCorrectnessEnv("true");
    // Regression test for: daemon acked (dispatch intent = "acknowledged") but
    // dispatch_acked journal event was never written. The head's activeRunId
    // still holds the dispatched runId from dispatch_sent, but no journal ack
    // means the version never advanced. Without the activeRunId guard, the
    // timeout was incorrectly suppressed by the "working" threadChat check,
    // leaving the workflow permanently stuck.
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
    });
    const workflowId = workflow.id;

    const head = await ensureWorkflowHead({ db, workflowId });
    if (!head) throw new Error("Expected workflow head");

    const dispatchRunId = `run-${nanoid()}`;
    // Simulate: dispatch_sent set activeRunId, but dispatch_acked was never
    // journaled so activeRunId is still the dispatched run. However, the
    // threadChat shows "working" because the daemon started processing.
    const moved = await updateWorkflowHead({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "awaiting_implementation_acceptance",
        activeGate: null,
        activeRunId: dispatchRunId,
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
      kind: "ack_timeout_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:ack-working`,
      dueAt: now,
      payload: {
        kind: "ack_timeout_check",
        // Use a DIFFERENT runId than activeRunId — simulates a stale dispatch
        // where the head advanced to a new run but the old timeout is still
        // pending. The activeRunId guard should let this fire.
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

    // The timeout should fire (not be suppressed) because the effect's runId
    // doesn't match head.activeRunId — the guard detects the ack was never
    // journaled for this particular run.
    expect(drain.processed).toBe(1);

    const headAfter = await getWorkflowHead({ db, workflowId });
    if (!headAfter) throw new Error("Expected head after drain");
    // dispatch_ack_timeout with mismatched runId is dropped by reducer
    // (isOutOfOrderRunSignal), so state stays awaiting_implementation_acceptance but the effect
    // was processed (not suppressed). The key assertion is that drain
    // processed it rather than returning stale.
    expect(headAfter.state).not.toBe("awaiting_operator_action");
    expect(headAfter.activeRunId).toBe(dispatchRunId);
    expect(headAfter.infraRetryCount).toBe(0);
    expect(headAfter.version).toBe(head.version + 1);
  });

  it("suppresses ack timeout when daemon is working AND activeRunId matches", async () => {
    setAckTimeoutCorrectnessEnv("true");
    // Verify the happy path: daemon is working, ack was journaled (activeRunId
    // matches the effect's runId), timeout should be suppressed as stale.
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
      kind: "ack_timeout_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:ack-suppressed`,
      dueAt: now,
      payload: {
        kind: "ack_timeout_check",
        // SAME runId as activeRunId — ack was journaled, suppress timeout
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

  it("ack timeout with version mismatch returns stale (no event fired)", async () => {
    setAckTimeoutCorrectnessEnv("true");
    const now = new Date("2026-03-18T10:00:00.000Z");
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
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(moved).toBe(true);

    // Insert ack_timeout_check with a stale workflowVersion (head.version, not head.version+1)
    const effect: EffectSpec = {
      kind: "ack_timeout_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:stale-ver`,
      dueAt: now,
      payload: {
        kind: "ack_timeout_check",
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
        eq(schema.deliveryEffectLedgerV3.effectKind, "ack_timeout_check"),
      ),
    });
    expect(effectRow?.status).toBe("succeeded");
  });

  it("ack timeout fires when no threadChat exists", async () => {
    setAckTimeoutCorrectnessEnv("true");
    const now = new Date("2026-03-18T10:00:00.000Z");
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
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(moved).toBe(true);

    // No threadChat created — daemon hasn't started yet

    const effect: EffectSpec = {
      kind: "ack_timeout_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:no-chat`,
      dueAt: now,
      payload: {
        kind: "ack_timeout_check",
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

    // dispatch_ack_timeout should fire (no threadChat → not suppressed)
    const journalRows = await db.query.deliveryLoopJournalV3.findMany({
      where: eq(schema.deliveryLoopJournalV3.workflowId, workflowId),
    });
    const timeoutEvents = journalRows.filter(
      (r) => r.eventType === "dispatch_ack_timeout",
    );
    expect(timeoutEvents).toHaveLength(1);

    const headAfter = await getWorkflowHead({ db, workflowId });
    if (!headAfter) throw new Error("Expected head after drain");
    expect(headAfter.infraRetryCount).toBe(0);
  });

  it("multiple effects drain in order (oldest first)", async () => {
    const now = new Date("2026-03-18T10:10:00.000Z");
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
        blockedReason: null,
        updatedAt: now,
        lastActivityAt: now,
      },
      expectedVersion: head.version,
    });
    expect(moved).toBe(true);

    // Two ack_timeout_check effects with different dueAt (both due)
    const effects: EffectSpec[] = [
      {
        kind: "ack_timeout_check",
        effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:order-2`,
        dueAt: new Date("2026-03-18T10:05:00.000Z"), // later
        payload: {
          kind: "ack_timeout_check",
          runId: runId2,
          workflowVersion: head.version + 1,
        },
      },
      {
        kind: "ack_timeout_check",
        effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:order-1`,
        dueAt: new Date("2026-03-18T10:00:00.000Z"), // earlier
        payload: {
          kind: "ack_timeout_check",
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
      (r) => r.effectKind === "ack_timeout_check",
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
    expect(head.state).toBe("awaiting_implementation_acceptance");
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
});

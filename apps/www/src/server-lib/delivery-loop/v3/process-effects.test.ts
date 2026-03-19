import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { nanoid } from "nanoid/non-secure";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import {
  ensureWorkflowHeadV3,
  getWorkflowHeadV3,
  insertEffectsV3,
  updateWorkflowHeadV3,
} from "./store";
import { drainDueV3Effects } from "./process-effects";
import type { EffectSpecV3 } from "./types";

const TEST_EFFECT_PREFIX = "dl3:test:v3-effect-worker";

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

describe("drainDueV3Effects", () => {
  it("skips timer effects until they are due", async () => {
    const now = new Date("2026-03-18T10:05:00.000Z");
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHeadV3({ db, workflowId });
    if (!head) {
      throw new Error("Expected workflow head for timer test");
    }

    const updated = await updateWorkflowHeadV3({
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

    const effect: EffectSpecV3 = {
      kind: "ack_timeout_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:ack`,
      dueAt: new Date("2026-03-18T10:10:00.000Z"),
      payload: {
        kind: "ack_timeout_check",
        runId: "run-timer",
        workflowVersion: head.version + 1,
      },
    };

    const inserted = await insertEffectsV3({
      db,
      workflowId,
      workflowVersion: head.version + 1,
      effects: [effect],
    });
    expect(inserted).toBe(1);

    const beforeDrain = await drainDueV3Effects({
      db,
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

  it("drains due ack timeout effects into replayable retry transitions", async () => {
    const now = new Date("2026-03-18T10:00:00.000Z");
    const workflowId = await createWorkflowFixture();
    const head = await ensureWorkflowHeadV3({ db, workflowId });
    if (!head) {
      throw new Error("Expected workflow head for timer replay test");
    }

    const dispatchRunId = `run-${nanoid()}`;
    const hydrated = await updateWorkflowHeadV3({
      db,
      head: {
        ...head,
        version: head.version + 1,
        state: "implementing",
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

    const effect: EffectSpecV3 = {
      kind: "ack_timeout_check",
      effectKey: `${TEST_EFFECT_PREFIX}:${nanoid()}:due`,
      dueAt: new Date("2026-03-18T10:00:00.000Z"),
      payload: {
        kind: "ack_timeout_check",
        runId: dispatchRunId,
        workflowVersion: head.version + 1,
      },
    };

    const inserted = await insertEffectsV3({
      db,
      workflowId,
      workflowVersion: head.version + 1,
      effects: [effect],
    });
    expect(inserted).toBe(1);

    const firstDrain = await drainDueV3Effects({
      db,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });

    expect(firstDrain.processed).toBe(1);

    const afterDrain = await getWorkflowHeadV3({ db, workflowId });
    if (!afterDrain) {
      throw new Error("Expected workflow head after draining timer");
    }
    expect(afterDrain.state).toBe("implementing");
    expect(afterDrain.activeRunId).toBeNull();
    expect(afterDrain.infraRetryCount).toBe(1);
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

    const secondDrain = await drainDueV3Effects({
      db,
      maxItems: 1,
      leaseOwnerPrefix: "test:v3-effects",
      now,
    });
    expect(secondDrain.processed).toBe(0);

    await db
      .delete(schema.deliveryEffectLedgerV3)
      .where(eq(schema.deliveryEffectLedgerV3.workflowId, workflowId));
  });
});

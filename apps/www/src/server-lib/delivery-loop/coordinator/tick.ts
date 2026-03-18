import type { DB } from "@terragon/shared/db";
import type {
  WorkflowId,
  CorrelationId,
  DeliveryWorkflow,
  WorkflowState,
} from "@terragon/shared/delivery-loop/domain/workflow";
import { reduceWorkflow } from "@terragon/shared/delivery-loop/domain/transitions";
import { derivePendingAction } from "@terragon/shared/delivery-loop/domain/transitions";
import {
  deriveHealth,
  shouldOpenIncident,
} from "@terragon/shared/delivery-loop/domain/observability";
import {
  getWorkflow,
  updateWorkflowState,
} from "@terragon/shared/delivery-loop/store/workflow-store";
import { appendWorkflowEvent } from "@terragon/shared/delivery-loop/store/event-store";
import {
  claimNextUnprocessedSignal,
  completeSignalClaim,
  releaseSignalClaim,
  deadLetterSignal,
} from "@terragon/shared/delivery-loop/store/signal-inbox-store";
import {
  enqueueWorkItem,
  supersedePendingWorkItems,
} from "@terragon/shared/delivery-loop/store/work-queue-store";
import { upsertRuntimeStatus } from "@terragon/shared/delivery-loop/store/runtime-status-store";
import {
  openIncident,
  getOpenIncidents,
} from "@terragon/shared/delivery-loop/store/incident-store";

import { reduceSignalToEvent } from "./reduce-signals";
import { resolveWorkItems } from "./schedule-work";
import { buildWorkflowEvent } from "./append-events";
import {
  extractHeadSha,
  extractGateKind,
  extractReviewSurface,
  serializeWorkflowState,
} from "./helpers";
import { parseSignalPayload } from "./parse-signal";

export type CoordinatorTickResult = {
  workflowId: WorkflowId;
  correlationId: CorrelationId;
  signalsProcessed: number;
  transitioned: boolean;
  stateBefore: string;
  stateAfter: string;
  workItemsScheduled: number;
  incidentsEvaluated: boolean;
};

const MAX_SIGNALS_PER_TICK = 10;

const VALID_WORKFLOW_KINDS: ReadonlySet<string> = new Set<WorkflowState>([
  "planning",
  "implementing",
  "gating",
  "awaiting_pr",
  "babysitting",
  "awaiting_plan_approval",
  "awaiting_manual_fix",
  "awaiting_operator_action",
  "done",
  "stopped",
  "terminated",
]);

export async function runCoordinatorTick(params: {
  db: DB;
  workflowId: WorkflowId;
  correlationId: CorrelationId;
  claimToken?: string;
  /** The loopId used to key signals in the inbox. When callers write signals
   *  under a v1 sdlcLoop ID (e.g. daemon-event route, route-feedback), they
   *  must pass that same ID here so the coordinator drains the correct rows.
   *  Defaults to workflowId for pure v2 adapters that key signals by workflow. */
  loopId?: string;
  now?: Date;
}): Promise<CoordinatorTickResult> {
  const {
    db,
    workflowId,
    correlationId,
    claimToken = correlationId,
    loopId = workflowId,
    now = new Date(),
  } = params;

  // 1. Load workflow aggregate
  const workflowRow = await getWorkflow({ db, workflowId });
  if (!workflowRow) {
    throw new Error(`Workflow ${workflowId} not found`);
  }

  // Hydrate the workflow from the DB row into our domain type.
  // The store returns a row; we cast to the domain aggregate since the
  // store schema mirrors the discriminated union shape.
  let workflow = hydrateWorkflow(workflowRow);
  const stateBefore = workflow.kind;

  let signalsProcessed = 0;
  let transitioned = false;
  let workItemsScheduled = 0;
  let pendingAction: ReturnType<typeof derivePendingAction> = null;

  // 2. Process pending signals (up to limit per tick)
  let versionConflict = false;
  // Track signal IDs released as retryable within this tick so the
  // claim query excludes them. This allows later signals to be
  // processed even when an earlier signal is not yet actionable.
  const retryableSignalIds = new Set<string>();
  for (let i = 0; i < MAX_SIGNALS_PER_TICK; i++) {
    const signal = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken,
      now,
      excludeIds: retryableSignalIds.size > 0 ? retryableSignalIds : undefined,
    });
    if (!signal) break;

    // Wrap per-signal processing in try/catch so that a failure in one
    // signal doesn't leak the claim — the signal gets released for retry.
    let signalCompleted = false;
    try {
      // 3a. Reduce signal to a LoopEvent
      const parseResult = parseSignalPayload(signal.causeType, signal.payload);
      if (!parseResult) {
        // Unrecognized signal — dead-letter it
        await deadLetterSignal({
          db,
          signalId: signal.id,
          claimToken,
          reason: `Unrecognized signal cause type: ${signal.causeType}`,
          now,
        });
        signalCompleted = true;
        signalsProcessed++;
        continue;
      }
      if ("retryable" in parseResult) {
        console.warn(
          `[coordinator] Releasing retryable signal ${signal.id}: ${parseResult.reason}`,
        );
        await releaseSignalClaim({ db, signalId: signal.id, claimToken });
        retryableSignalIds.add(signal.id);
        continue;
      }
      const deliverySignal = parseResult;

      // Wrap reduction in try/catch so malformed payloads (poison pills)
      // get dead-lettered instead of released for infinite retry.
      let reduction: ReturnType<typeof reduceSignalToEvent>;
      try {
        reduction = reduceSignalToEvent({
          signal: deliverySignal,
          workflow,
          prNumber: workflowRow.prNumber,
        });
      } catch (reductionErr) {
        console.warn(
          `[coordinator] Poison-pill signal ${signal.id}: reduction threw`,
          { causeType: signal.causeType, error: reductionErr },
        );
        await deadLetterSignal({
          db,
          signalId: signal.id,
          claimToken,
          reason: `Signal reduction error: ${reductionErr instanceof Error ? reductionErr.message : String(reductionErr)}`,
          now,
        });
        signalCompleted = true;
        signalsProcessed++;
        continue;
      }

      if (!reduction) {
        // No state transition for this signal — complete it and move on
        await completeSignalClaim({
          db,
          signalId: signal.id,
          claimToken,
          now,
        });
        signalCompleted = true;
        signalsProcessed++;
        continue;
      }
      if ("retryable" in reduction) {
        console.warn(
          `[coordinator] Releasing retryable signal ${signal.id}: ${reduction.reason}`,
        );
        await releaseSignalClaim({ db, signalId: signal.id, claimToken });
        retryableSignalIds.add(signal.id);
        continue;
      }

      // 3b. Apply the state machine transition
      const newWorkflow = reduceWorkflow({
        snapshot: workflow,
        event: reduction.event,
        context: reduction.context,
        now,
      });

      if (!newWorkflow) {
        // Invalid transition — log warning and skip
        console.warn(
          `[coordinator] Invalid transition: ${workflow.kind} + ${reduction.event} (workflow=${workflowId})`,
        );
        await completeSignalClaim({
          db,
          signalId: signal.id,
          claimToken,
          now,
        });
        signalCompleted = true;
        signalsProcessed++;
        continue;
      }

      // 3c. Resolve work items from the transition
      const scheduledItems = resolveWorkItems({
        previousWorkflow: workflow,
        newWorkflow,
        event: reduction.event,
        loopId,
        now,
      });

      // 3d. Build the audit event
      const workflowEvent = buildWorkflowEvent({
        previousWorkflow: workflow,
        newWorkflow,
        event: reduction.event,
        context: reduction.context,
      });

      // 4. Persist everything in a single transaction
      await db.transaction(async (tx) => {
        // 4a. Update workflow state (optimistic concurrency)
        const updateResult = await updateWorkflowState({
          db: tx,
          workflowId,
          expectedVersion: workflow.version,
          kind: newWorkflow.kind,
          stateJson: serializeWorkflowState(newWorkflow),
          fixAttemptCount: newWorkflow.fixAttemptCount,
          headSha: extractHeadSha(newWorkflow),
          reviewSurfaceJson: extractReviewSurface(newWorkflow),
          now,
        });

        if (!updateResult.updated) {
          // Version conflict — another tick updated this workflow concurrently.
          // Break out so the current signal stays "claimed" and can be retried.
          console.warn(
            `[coordinator] Version conflict on workflow ${workflowId} (expected ${workflow.version}), yielding tick`,
          );
          versionConflict = true;
          return; // exit transaction without persisting
        }

        // 4b. Append audit event
        await appendWorkflowEvent({
          db: tx,
          workflowId,
          correlationId,
          eventKind: workflowEvent.kind,
          stateBefore: workflow.kind,
          stateAfter: newWorkflow.kind,
          gateBefore: extractGateKind(workflow),
          gateAfter: extractGateKind(newWorkflow),
          payloadJson: workflowEvent as unknown as Record<string, unknown>,
          signalId: signal.id,
          triggerSource: deliverySignal.source,
          headSha: extractHeadSha(newWorkflow),
        });

        // 4c. Supersede old pending work items before inserting new ones
        const uniqueKinds = [
          ...new Set(scheduledItems.map((item) => item.kind)),
        ];
        await Promise.all(
          uniqueKinds.map((kind) =>
            supersedePendingWorkItems({ db: tx, workflowId, kind, now }),
          ),
        );

        // 4d. Enqueue work items
        await Promise.all(
          scheduledItems.map((item) =>
            enqueueWorkItem({
              db: tx,
              workflowId,
              correlationId,
              kind: item.kind,
              payloadJson: item.payloadJson,
              scheduledAt: item.scheduledAt,
            }),
          ),
        );

        // 4e. Update runtime status (cache for reuse after the transaction)
        pendingAction = derivePendingAction(newWorkflow);
        await upsertRuntimeStatus({
          db: tx,
          workflowId,
          state: newWorkflow.kind,
          gate: extractGateKind(newWorkflow),
          pendingActionKind: pendingAction?.kind ?? null,
          health: "healthy",
          lastSignalAt: now,
          lastTransitionAt: now,
          fixAttemptCount: newWorkflow.fixAttemptCount,
        });
      });

      // If version conflict occurred, release the claim so the signal is
      // immediately available for the next tick (instead of waiting for
      // stale-claim timeout).
      if (versionConflict) {
        await releaseSignalClaim({ db, signalId: signal.id, claimToken });
        break;
      }

      // 4f. Complete the signal (outside transaction — idempotent)
      await completeSignalClaim({ db, signalId: signal.id, claimToken, now });
      signalCompleted = true;

      // Update in-memory workflow for next iteration
      workflow = newWorkflow;
      transitioned = true;
      signalsProcessed++;
      workItemsScheduled += scheduledItems.length;
    } catch (signalErr) {
      // Release claim so another tick can retry this signal instead of
      // leaving it permanently stuck in "claimed" state.
      if (!signalCompleted) {
        try {
          await releaseSignalClaim({ db, signalId: signal.id, claimToken });
        } catch {
          // Best-effort — stale-claim timeout will eventually release it
        }
      }
      console.error(
        `[coordinator] Error processing signal ${signal.id} for workflow ${workflowId}`,
        signalErr,
      );
      // Break out of the loop — don't process more signals after a failure
      // since our in-memory workflow state may be inconsistent.
      break;
    }
  }

  // 5. Evaluate incident conditions (skip expensive incident queries on noop ticks)
  let incidentsEvaluated = false;
  let openIncidents: Awaited<ReturnType<typeof getOpenIncidents>> = [];
  let incidentCheck: ReturnType<typeof shouldOpenIncident> = null;

  if (signalsProcessed > 0 || transitioned) {
    const phaseDurationMs = now.getTime() - workflow.updatedAt.getTime();
    openIncidents = await getOpenIncidents({ db, workflowId });

    incidentCheck = shouldOpenIncident({
      workflow,
      phaseDurationMs,
      fixAttemptCount: workflow.fixAttemptCount,
      maxFixAttempts: workflow.maxFixAttempts,
      unprocessedSignalCount: 0, // post-processing, signals are drained
      dlqSignalCount: 0,
    });

    if (incidentCheck) {
      const alreadyOpen = openIncidents.some(
        (i) => i.incidentType === incidentCheck!.incidentType,
      );
      if (!alreadyOpen) {
        await openIncident({
          db,
          workflowId,
          incidentType: incidentCheck.incidentType,
          severity: incidentCheck.severity,
          detail: incidentCheck.detail,
          now,
        });
      }
      incidentsEvaluated = true;
    }
  }

  // Skip runtime status on version conflict — the winning tick wrote
  // the authoritative state; our stale snapshot would overwrite it.
  if (versionConflict) {
    return {
      workflowId,
      correlationId,
      signalsProcessed,
      transitioned,
      stateBefore,
      stateAfter: workflow.kind,
      workItemsScheduled,
      incidentsEvaluated: false,
    };
  }

  // Update runtime status (always — tests and dashboards expect it)
  const health =
    signalsProcessed > 0 || transitioned
      ? deriveHealth({
          workflow,
          oldestUnprocessedSignalAge: 0,
          openIncidents: openIncidents.map((i) => ({
            id: i.id,
            workflowId: workflowId,
            incidentType: i.incidentType,
            severity: i.severity as "warning" | "critical",
            status: i.status as "open" | "acknowledged" | "resolved",
            detail: i.detail ?? "",
            openedAt: i.openedAt ?? now,
            resolvedAt: i.resolvedAt ?? null,
          })),
          now,
        })
      : { kind: "healthy" as const };

  await upsertRuntimeStatus({
    db,
    workflowId,
    state: workflow.kind,
    gate: extractGateKind(workflow),
    pendingActionKind:
      (pendingAction ?? derivePendingAction(workflow))?.kind ?? null,
    health: health.kind,
    lastSignalAt: signalsProcessed > 0 ? now : null,
    lastTransitionAt: transitioned ? now : null,
    fixAttemptCount: workflow.fixAttemptCount,
    openIncidentCount:
      openIncidents.length +
      (incidentCheck &&
      !openIncidents.some((i) => i.incidentType === incidentCheck!.incidentType)
        ? 1
        : 0),
  });

  return {
    workflowId,
    correlationId,
    signalsProcessed,
    transitioned,
    stateBefore,
    stateAfter: workflow.kind,
    workItemsScheduled,
    incidentsEvaluated,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Hydrate a DB row into the domain DeliveryWorkflow aggregate.
 * The DB stores kind + stateJson; we merge them into the discriminated union.
 */
type WorkflowRow = NonNullable<Awaited<ReturnType<typeof getWorkflow>>>;

/** Date-typed fields that may appear in stateJson as ISO strings. */
const DATE_FIELDS_IN_STATE = new Set([
  "nextCheckAt",
  "sentAt",
  "ackDeadlineAt",
  "completedAt",
]);

function hydrateWorkflow(row: WorkflowRow): DeliveryWorkflow {
  if (!VALID_WORKFLOW_KINDS.has(row.kind)) {
    throw new Error(
      `Invalid workflow kind "${row.kind}" for workflow ${row.id}`,
    );
  }
  const stateJson = (row.stateJson ?? {}) as Record<string, unknown>;

  // Rehydrate ISO-string dates back to Date objects so downstream
  // comparisons (e.g. `nextCheckAt < now`) work correctly.
  for (const key of DATE_FIELDS_IN_STATE) {
    if (typeof stateJson[key] === "string") {
      stateJson[key] = new Date(stateJson[key] as string);
    }
  }

  return {
    workflowId: row.id as WorkflowId,
    threadId:
      row.threadId as import("@terragon/shared/delivery-loop/domain/workflow").ThreadId,
    generation: row.generation,
    version: row.version,
    fixAttemptCount: row.fixAttemptCount,
    maxFixAttempts: row.maxFixAttempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt ?? null,
    kind: row.kind as WorkflowState,
    ...stateJson,
  } as DeliveryWorkflow;
}

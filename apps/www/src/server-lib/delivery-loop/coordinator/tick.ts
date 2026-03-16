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

const VALID_SIGNAL_SOURCES: ReadonlySet<string> = new Set([
  "daemon",
  "github",
  "human",
  "timer",
  "babysit",
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
  for (let i = 0; i < MAX_SIGNALS_PER_TICK; i++) {
    const signal = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken,
      now,
    });
    if (!signal) break;

    // Wrap per-signal processing in try/catch so that a failure in one
    // signal doesn't leak the claim — the signal gets released for retry.
    let signalCompleted = false;
    try {
      // 3a. Reduce signal to a LoopEvent
      const deliverySignal = parseSignalPayload(
        signal.causeType,
        signal.payload,
      );
      if (!deliverySignal) {
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

      // Wrap reduction in try/catch so malformed payloads (poison pills)
      // get dead-lettered instead of released for infinite retry.
      let reduction: ReturnType<typeof reduceSignalToEvent>;
      try {
        reduction = reduceSignalToEvent({
          signal: deliverySignal,
          workflow,
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

type SignalCauseType = string;

function parseSignalPayload(
  causeType: SignalCauseType,
  payload: Record<string, unknown> | null,
):
  | import("@terragon/shared/delivery-loop/domain/signals").DeliverySignal
  | null {
  if (!payload) return null;

  // Map the v1 cause types to v2 DeliverySignal shape.
  // The signal inbox stores signals with causeType + payload; we
  // translate to the typed discriminated union here.
  const source = payload.source as string | undefined;
  const event = payload.event as Record<string, unknown> | undefined;

  if (source && event) {
    // Validate source is a known value and event has a kind field
    if (!VALID_SIGNAL_SOURCES.has(source)) return null;
    if (typeof event.kind !== "string") return null;
    // Already in v2 shape
    return payload as unknown as import("@terragon/shared/delivery-loop/domain/signals").DeliverySignal;
  }

  // Attempt v1 causeType mapping
  switch (causeType) {
    case "daemon_run_completed":
    case "daemon_run_failed":
    case "daemon_progress":
      return {
        source: "daemon",
        event:
          payload as unknown as import("@terragon/shared/delivery-loop/domain/signals").DaemonSignal,
      };
    case "github_ci_changed":
    case "github_review_changed":
    case "github_pr_closed":
    case "github_pr_synchronized":
      return {
        source: "github",
        event:
          payload as unknown as import("@terragon/shared/delivery-loop/domain/signals").GitHubSignal,
      };
    case "human_resume":
    case "human_bypass":
    case "human_stop":
    case "human_mark_done":
      return {
        source: "human",
        event:
          payload as unknown as import("@terragon/shared/delivery-loop/domain/signals").HumanSignal,
      };
    case "timer_dispatch_ack_expired":
    case "timer_babysit_due":
    case "timer_heartbeat":
      return {
        source: "timer",
        event:
          payload as unknown as import("@terragon/shared/delivery-loop/domain/signals").TimerSignal,
      };
    case "babysit_recheck_passed":
      return {
        source: "babysit",
        event:
          payload as unknown as import("@terragon/shared/delivery-loop/domain/signals").BabysitSignal,
      };

    // -- Legacy v1 cause types written by daemon-event route & route-feedback --

    case "daemon_terminal": {
      const daemonRunStatus = payload.daemonRunStatus as string | undefined;
      const runId =
        (payload.runId as string) ?? (payload.eventId as string) ?? "unknown";
      const headSha = payload.headShaAtCompletion as string | undefined;
      const errorMessage = payload.daemonErrorMessage as string | undefined;

      if (
        daemonRunStatus === "completed" ||
        daemonRunStatus === "plan_completed"
      ) {
        // Refuse to emit a successful completion without a real head SHA.
        // Downstream gates and babysit evaluation require a stable commit
        // reference; advancing with an empty SHA strands the workflow.
        if (!headSha) return null;
        return {
          source: "daemon",
          event: {
            kind: "run_completed",
            runId,
            result: {
              kind: "success",
              headSha,
              summary: "",
            },
          },
        };
      }
      if (daemonRunStatus === "stopped") {
        // User-initiated stop — map to human signal for clean termination
        return {
          source: "human",
          event: { kind: "stop_requested", actorUserId: "daemon" },
        };
      }
      if (daemonRunStatus === "failed" || daemonRunStatus === "error") {
        return {
          source: "daemon",
          event: {
            kind: "run_failed",
            runId,
            failure: {
              kind: "runtime_crash",
              exitCode: null,
              message: errorMessage ?? "Unknown error",
            },
          },
        };
      }
      // Other statuses (e.g., "processing") — treat as progress
      return {
        source: "daemon",
        event: {
          kind: "progress_reported",
          runId,
          progress: { completedTasks: 0, totalTasks: 0, currentTask: null },
        },
      };
    }

    case "check_run.completed":
    case "check_suite.completed": {
      const checkOutcome = payload.checkOutcome as string | undefined;
      const prNumber = (payload.prNumber as number) ?? 0;
      return {
        source: "github",
        event: {
          kind: "ci_changed",
          prNumber,
          result: {
            passed: checkOutcome === "success" || checkOutcome === "pass",
            requiredChecks:
              (payload.ciSnapshotCheckNames as readonly string[]) ?? [],
            failingChecks:
              (payload.ciSnapshotFailingChecks as readonly string[]) ?? [],
          },
        },
      };
    }

    case "pull_request_review":
    case "pull_request_review_comment": {
      const prNumber = (payload.prNumber as number) ?? 0;
      const reviewState = payload.reviewState as string | undefined;
      const unresolvedThreadCount =
        (payload.unresolvedThreadCount as number) ?? 0;
      return {
        source: "github",
        event: {
          kind: "review_changed",
          prNumber,
          result: {
            passed: reviewState === "approved" && unresolvedThreadCount === 0,
            unresolvedThreadCount,
            approvalCount: reviewState === "approved" ? 1 : 0,
            requiredApprovals: 1,
          },
        },
      };
    }

    case "pull_request.synchronize": {
      const headSha = (payload.headSha as string) ?? "";
      const prNumber = (payload.prNumber as number) ?? 0;
      return {
        source: "github",
        event: {
          kind: "pr_synchronized",
          prNumber,
          headSha,
        },
      };
    }

    case "pull_request.closed": {
      const prNumber = (payload.prNumber as number) ?? 0;
      const merged = (payload.merged as boolean) ?? false;
      return {
        source: "github",
        event: {
          kind: "pr_closed",
          prNumber,
          merged,
        },
      };
    }

    default:
      return null;
  }
}

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

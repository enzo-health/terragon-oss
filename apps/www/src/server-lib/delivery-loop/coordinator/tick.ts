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
  appendSignalToInbox,
} from "@terragon/shared/delivery-loop/store/signal-inbox-store";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  enqueueWorkItem,
  supersedePendingWorkItems,
} from "@terragon/shared/delivery-loop/store/work-queue-store";
import { upsertRuntimeStatus } from "@terragon/shared/delivery-loop/store/runtime-status-store";
import {
  openIncident,
  getOpenIncidents,
} from "@terragon/shared/delivery-loop/store/incident-store";

import { reduceSignalToEvent, type ReductionContext } from "./reduce-signals";
import { resolveWorkItems } from "./schedule-work";
import { buildWorkflowEvent } from "./append-events";
import {
  extractHeadSha,
  extractGateKind,
  extractReviewSurface,
  serializeWorkflowState,
} from "./helpers";
import { parseSignalPayload } from "./parse-signal";
import { updateWorkflowPR } from "@terragon/shared/delivery-loop/store/workflow-store";
import { updateThread } from "@terragon/shared/model/threads";
import { upsertGithubPR } from "@terragon/shared/model/github";
import { getGithubPRStatus } from "@terragon/shared/github-api/helpers";
import {
  getDefaultBranchForRepo,
  getExistingPRForBranch,
  getOctokitForUserOrThrow,
  parseRepoFullName,
} from "@/lib/github";
import { publicAppUrl } from "@terragon/env/next-public";
import { eq } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";

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

type AwaitingPrInvariantAction = {
  kind: "awaiting_pr_invariant_no_diff" | "awaiting_pr_invariant_pr_linked";
  stateAfter: WorkflowState;
  signalId: string;
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
  /** Override gate-skip behavior. When true, auto-injects bypass signals for
   *  gating states. When omitted, reads the `skipDeliveryLoopGates` feature
   *  flag for the workflow's owner. */
  skipGates?: boolean;
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

  // Resolve gate-skip flag: explicit param > feature flag for workflow owner
  const skipGates =
    params.skipGates ??
    (workflowRow.userId
      ? await getFeatureFlagForUser({
          db,
          userId: workflowRow.userId,
          flagName: "skipDeliveryLoopGates",
        })
      : false);

  let signalsProcessed = 0;
  let transitioned = false;
  let workItemsScheduled = 0;
  let pendingAction: ReturnType<typeof derivePendingAction> = null;

  // Build reduction context once for the tick
  const reductionContext: ReductionContext = {
    workflowId,
    prNumber: workflowRow.prNumber ?? null,
    now,
  };

  // Enforce awaiting_pr invariant before draining signals.
  // Invalid state: awaiting_pr + no PR link + no diff.
  // Resolution policy:
  // - no diff => mark_done
  // - PR already linked on thread => pr_linked
  // - diff + no PR => create/link PR then pr_linked
  const awaitingPrInvariantAction = await enforceAwaitingPrInvariant({
    db,
    workflowId,
    loopId,
    now,
    workflow,
    workflowRow,
  });
  if (awaitingPrInvariantAction) {
    await appendWorkflowEvent({
      db,
      workflowId,
      correlationId,
      eventKind: "awaiting_pr_invariant",
      stateBefore: workflow.kind,
      stateAfter: awaitingPrInvariantAction.stateAfter,
      gateBefore: extractGateKind(workflow),
      gateAfter: extractGateKind(workflow),
      payloadJson: {
        kind: awaitingPrInvariantAction.kind,
        signalId: awaitingPrInvariantAction.signalId,
      },
      signalId: awaitingPrInvariantAction.signalId,
      triggerSource: "system",
    });
  }

  // 2. Process pending signals (up to limit per tick)
  //    The outer do/while handles level-triggered gate bypass: when the
  //    workflow is already in gating with skipGates but no signals exist,
  //    we inject a bypass signal after the first (empty) pass and re-enter.
  let versionConflict = false;
  let levelBypassInjected = false;
  // Track signal IDs released as retryable within this tick so the
  // claim query excludes them. This allows later signals to be
  // processed even when an earlier signal is not yet actionable.
  const retryableSignalIds = new Set<string>();
  do {
    for (let i = 0; i < MAX_SIGNALS_PER_TICK; i++) {
      const signal = await claimNextUnprocessedSignal({
        db,
        loopId,
        claimToken,
        now,
        excludeIds:
          retryableSignalIds.size > 0 ? retryableSignalIds : undefined,
      });
      if (!signal) break;

      // Wrap per-signal processing in try/catch so that a failure in one
      // signal doesn't leak the claim — the signal gets released for retry.
      let signalCompleted = false;
      try {
        // 3a. Reduce signal to a LoopEvent
        const parseResult = parseSignalPayload(
          signal.causeType,
          signal.payload,
        );
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
            reductionContext,
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

        // 3b. Merge failure signature updates into the in-memory workflow
        if (
          "signatureUpdate" in reduction &&
          reduction.signatureUpdate &&
          workflow.kind === "implementing"
        ) {
          workflow = {
            ...workflow,
            failureSignatures: reduction.signatureUpdate,
          };
        }

        // 3c. Apply the state machine transition
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

        // 3d. Resolve work items from the transition
        const scheduledItems = resolveWorkItems({
          previousWorkflow: workflow,
          newWorkflow,
          event: reduction.event,
          loopId,
          now,
        });

        // 3e. Build the audit event
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
            infraRetryCount: newWorkflow.infraRetryCount,
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

        // Auto-inject bypass signal when entering gating with skipGates enabled.
        // The next loop iteration picks it up, cascading through all 3 gates.
        if (skipGates && newWorkflow.kind === "gating") {
          const gateKind = newWorkflow.gate.kind;
          await appendSignalToInbox({
            db,
            loopId,
            causeType: "human_bypass",
            payload: {
              source: "human",
              event: {
                kind: "bypass_requested",
                actorUserId: "system:gate-skip",
                target: gateKind,
              },
            },
            canonicalCauseId: `auto-gate-skip:${workflowId}:${newWorkflow.version}:${gateKind}`,
            now,
          });
        }

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

    // 4g. Level-triggered gate bypass: when the workflow is already in gating
    // with skipGates enabled but no signals were processed (e.g. the flag was
    // enabled after the transition into gating), inject a bypass signal and
    // re-enter the signal loop so the cascade completes within this tick.
    if (
      skipGates &&
      !versionConflict &&
      !levelBypassInjected &&
      workflow.kind === "gating" &&
      signalsProcessed === 0
    ) {
      const gateKind = (
        workflow as Extract<DeliveryWorkflow, { kind: "gating" }>
      ).gate.kind;
      await appendSignalToInbox({
        db,
        loopId,
        causeType: "human_bypass",
        payload: {
          source: "human",
          event: {
            kind: "bypass_requested",
            actorUserId: "system:gate-skip",
            target: gateKind,
          },
        },
        canonicalCauseId: `auto-gate-skip:${workflowId}:${workflow.version}:${gateKind}`,
        now,
      });
      levelBypassInjected = true;
    }
  } while (levelBypassInjected && signalsProcessed === 0 && !versionConflict);

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
    infraRetryCount: row.infraRetryCount ?? 0,
    maxFixAttempts: row.maxFixAttempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt ?? null,
    kind: row.kind as WorkflowState,
    ...stateJson,
  } as DeliveryWorkflow;
}

function hasThreadDiff(params: {
  gitDiff: string | null;
  gitDiffStats: unknown;
}): boolean {
  const diffStats = params.gitDiffStats as
    | { files?: unknown; additions?: unknown; deletions?: unknown }
    | null
    | undefined;
  if (diffStats && typeof diffStats.files === "number") {
    return diffStats.files > 0;
  }
  if (!params.gitDiff) {
    return false;
  }
  return params.gitDiff.trim().length > 0;
}

async function ensureOrCreatePrForAwaitingWorkflow(params: {
  db: DB;
  workflowId: WorkflowId;
  userId: string;
  threadId: string;
  threadName: string | null;
  repoFullName: string;
  branchName: string;
  repoBaseBranchName: string | null;
}): Promise<number | null> {
  const branchName = params.branchName.trim();
  if (branchName.length === 0) {
    return null;
  }

  let baseBranchName = (params.repoBaseBranchName ?? "").trim();
  if (baseBranchName.length === 0) {
    baseBranchName = await getDefaultBranchForRepo({
      userId: params.userId,
      repoFullName: params.repoFullName,
    });
  }
  if (baseBranchName === branchName) {
    baseBranchName = await getDefaultBranchForRepo({
      userId: params.userId,
      repoFullName: params.repoFullName,
    });
  }
  if (baseBranchName === branchName) {
    return null;
  }

  const existingPr = await getExistingPRForBranch({
    repoFullName: params.repoFullName,
    headBranchName: branchName,
    baseBranchName,
  });
  if (existingPr) {
    await Promise.all([
      upsertGithubPR({
        db: params.db,
        repoFullName: params.repoFullName,
        number: existingPr.number,
        threadId: params.threadId,
        updates: {
          status: getGithubPRStatus(existingPr),
        },
      }),
      updateThread({
        db: params.db,
        userId: params.userId,
        threadId: params.threadId,
        updates: {
          githubPRNumber: existingPr.number,
          branchName,
        },
      }),
      updateWorkflowPR({
        db: params.db,
        workflowId: params.workflowId,
        prNumber: existingPr.number,
      }),
    ]);
    return existingPr.number;
  }

  const [owner, repo] = parseRepoFullName(params.repoFullName);
  const octokit = await getOctokitForUserOrThrow({
    userId: params.userId,
  });

  const prTitle = params.threadName?.trim().length
    ? `Terragon: ${params.threadName.trim()}`
    : "Terragon: automated update";
  const taskUrl = `${publicAppUrl()}/task/${params.threadId}`;
  const prBody = [
    "Automated pull request created by Terragon Delivery Loop.",
    "",
    `Task: ${taskUrl}`,
  ].join("\n");

  const created = await octokit.rest.pulls.create({
    owner,
    repo,
    title: prTitle,
    body: prBody,
    head: branchName,
    base: baseBranchName,
    draft: true,
  });

  await Promise.all([
    upsertGithubPR({
      db: params.db,
      repoFullName: params.repoFullName,
      number: created.data.number,
      threadId: params.threadId,
      updates: {
        status: getGithubPRStatus(created.data),
      },
    }),
    updateThread({
      db: params.db,
      userId: params.userId,
      threadId: params.threadId,
      updates: {
        githubPRNumber: created.data.number,
        branchName,
      },
    }),
    updateWorkflowPR({
      db: params.db,
      workflowId: params.workflowId,
      prNumber: created.data.number,
    }),
  ]);

  return created.data.number;
}

async function enforceAwaitingPrInvariant(params: {
  db: DB;
  workflowId: WorkflowId;
  loopId: string;
  now: Date;
  workflow: DeliveryWorkflow;
  workflowRow: WorkflowRow;
}): Promise<AwaitingPrInvariantAction | null> {
  if (params.workflow.kind !== "awaiting_pr") {
    return null;
  }
  if (typeof params.workflowRow.prNumber === "number") {
    return null;
  }
  if (!params.workflowRow.userId) {
    return null;
  }

  const thread = await params.db.query.thread.findFirst({
    where: eq(schema.thread.id, params.workflow.threadId),
    columns: {
      id: true,
      userId: true,
      name: true,
      githubRepoFullName: true,
      githubPRNumber: true,
      repoBaseBranchName: true,
      branchName: true,
      gitDiff: true,
      gitDiffStats: true,
    },
  });
  if (!thread) {
    return null;
  }

  let prNumber: number | null =
    typeof thread.githubPRNumber === "number" ? thread.githubPRNumber : null;

  if (!prNumber) {
    const hasDiff = hasThreadDiff({
      gitDiff: thread.gitDiff,
      gitDiffStats: thread.gitDiffStats,
    });
    if (!hasDiff) {
      const signal = await appendSignalToInbox({
        db: params.db,
        loopId: params.loopId,
        causeType: "human_mark_done",
        payload: {
          source: "human",
          event: {
            kind: "mark_done_requested",
            actorUserId: "system:awaiting-pr-invariant",
          },
        },
        canonicalCauseId: `awaiting-pr-invariant:no-diff:${params.workflowId}:${params.workflow.version}`,
        now: params.now,
      });
      if (!signal) {
        return null;
      }
      return {
        kind: "awaiting_pr_invariant_no_diff",
        stateAfter: "done",
        signalId: signal.id,
      };
    }

    try {
      prNumber = await ensureOrCreatePrForAwaitingWorkflow({
        db: params.db,
        workflowId: params.workflowId,
        userId: params.workflowRow.userId,
        threadId: thread.id,
        threadName: thread.name,
        repoFullName: thread.githubRepoFullName,
        branchName: thread.branchName ?? "",
        repoBaseBranchName: thread.repoBaseBranchName,
      });
    } catch (error) {
      console.warn(
        "[coordinator] awaiting_pr invariant PR create/link failed",
        {
          workflowId: params.workflowId,
          threadId: thread.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    }
  } else {
    await updateWorkflowPR({
      db: params.db,
      workflowId: params.workflowId,
      prNumber,
    });
  }

  if (!prNumber) {
    return null;
  }

  const signal = await appendSignalToInbox({
    db: params.db,
    loopId: params.loopId,
    causeType: "github_pr_synchronized",
    payload: {
      source: "github",
      event: {
        kind: "pr_synchronized",
        prNumber,
        headSha: params.workflow.headSha,
      },
    },
    canonicalCauseId: `awaiting-pr-invariant:pr-linked:${params.workflowId}:${prNumber}`,
    now: params.now,
  });
  if (!signal) {
    return null;
  }
  return {
    kind: "awaiting_pr_invariant_pr_linked",
    stateAfter: "awaiting_pr",
    signalId: signal.id,
  };
}

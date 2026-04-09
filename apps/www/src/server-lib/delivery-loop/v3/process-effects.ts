import { and, eq, ne, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DB } from "@terragon/shared/db";
import type { AgentRunStatus } from "@terragon/shared/db/types";
import * as schema from "@terragon/shared/db/schema";
import type { DeliveryEffectLedgerV3Row } from "@terragon/shared/db/types";
import {
  createPlanArtifact,
  replacePlanTasksForArtifact,
} from "@terragon/shared/delivery-loop/store/artifact-store";
import { getWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import {
  createDispatchIntent as createDbDispatchIntent,
  markDispatchIntentDispatched,
} from "@terragon/shared/delivery-loop/store/dispatch-intent-store";
import { addMilliseconds } from "date-fns";
import { parseEffectPayload } from "./contracts";
import { appendEventAndAdvanceExplicit } from "./kernel";
import {
  claimNextEffect,
  getWorkflowHead,
  insertEffects,
  markEffectFailed,
  markEffectSucceeded,
} from "./store";
import {
  upsertDeliveryCanonicalStatusComment,
  upsertDeliveryCanonicalCheckSummary,
  classifyDeliveryPublicationFailure,
} from "@/server-lib/delivery-loop/publication";
import { extractLatestPlanText } from "@/server-lib/checkpoint-thread-internal";
import { parsePlanSpec } from "@/server-lib/delivery-loop/parse-plan-spec";
import type { PlanSpecSource } from "@/server-lib/delivery-loop/promote-plan";
import {
  createDispatchIntent,
  type CreateDispatchIntentParams,
} from "@/server-lib/delivery-loop/dispatch-intent";
import { DEFAULT_ACK_TIMEOUT_MS } from "@/server-lib/delivery-loop/ack-lifecycle";
import {
  launchDeliveryLoopDispatchFromIntent,
  maybeProcessFollowUpQueue,
} from "@/server-lib/process-follow-up-queue";
import { toSelectedAgent } from "@terragon/shared/delivery-loop/domain/dispatch-types";
import {
  type EffectPayload,
  isTerminalState,
  normalizeEffectApprovalPolicy,
  type EffectResult,
  type LoopEvent,
  type WorkflowState,
} from "./types";

const ACTIVE_RUN_CONTEXT_STATUSES = new Set<AgentRunStatus>(["processing"]);
type DeliveryWorkflowRecord = NonNullable<
  Awaited<ReturnType<typeof getWorkflow>>
>;
type ThreadChatRecord = NonNullable<
  Awaited<ReturnType<DB["query"]["threadChat"]["findFirst"]>>
>;
type PersistDispatchIntentResult = { ok: true } | { ok: false; reason: string };
type LaunchDispatchResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      errorKind: "not_started" | "error";
      cause?: string;
    };
type RealtimeDispatchIntentParamsInput = {
  workflowId: string;
  workflow: DeliveryWorkflowRecord;
  threadChatId: string;
  runId: string;
  targetPhase: CreateDispatchIntentParams["targetPhase"];
  selectedAgent: CreateDispatchIntentParams["selectedAgent"];
  executionClass: CreateDispatchIntentParams["executionClass"];
  gate?: CreateDispatchIntentParams["gate"];
};
type DispatchEffectLaunchContext = {
  workflow: DeliveryWorkflowRecord;
  threadChat: ThreadChatRecord;
  runId: string;
};
type DispatchEffectLaunchResult =
  | {
      ok: true;
      context: DispatchEffectLaunchContext;
      dispatchLaunched: true;
    }
  | {
      ok: true;
      context: DispatchEffectLaunchContext;
      dispatchLaunched: false;
      reason: string;
      errorKind: "not_started" | "error";
      cause?: string;
    }
  | { ok: false; reason: string };

/**
 * Pure mapping from effect result to the LoopEvent that should be fired.
 * Returns null for results that don't require a state transition (e.g., human
 * approval pending, stale lease expiry).
 */
export function effectResultToEvent(
  result: EffectResult,
  context?: { activeRunSeq: number | null },
): LoopEvent | null {
  switch (result.kind) {
    case "create_plan_artifact":
      if (result.outcome === "created" && result.approvalPolicy === "auto")
        return { type: "plan_completed" };
      if (result.outcome === "created") return null; // Human approval — UI fires plan_completed
      return { type: "plan_failed", reason: result.reason };

    case "dispatch_gate_review":
      if (result.outcome === "dispatched")
        return {
          type: "dispatch_queued",
          runId: result.runId,
          ackDeadlineAt: result.ackDeadlineAt,
        };
      return {
        type: "run_failed",
        runId: `gate-dispatch-failed-${Date.now()}`,
        runSeq: context?.activeRunSeq ?? null,
        message: result.reason,
        category: "effect_failure",
        lane: "infra",
      };

    case "ensure_pr":
      if (result.outcome === "linked")
        return { type: "pr_linked", prNumber: result.prNumber };
      return {
        type: "gate_review_failed",
        runSeq: context?.activeRunSeq ?? null,
        reason: result.reason,
      };

    case "dispatch_implementing":
      if (result.outcome === "dispatched")
        return {
          type: "dispatch_queued",
          runId: result.runId,
          ackDeadlineAt: result.ackDeadlineAt,
        };
      return {
        type: "run_failed",
        runId: `impl-dispatch-failed-${Date.now()}`,
        runSeq: context?.activeRunSeq ?? null,
        message: result.reason,
        category: "effect_failure",
        lane: "infra",
      };

    case "run_lease_expiry_check":
    case "ack_timeout_check":
      if (result.outcome === "fired")
        return { type: "dispatch_ack_timeout", runId: result.runId };
      return null; // Lease expired after the workflow had already advanced

    case "gate_staleness_check":
      if (result.outcome === "ci_passed")
        return { type: "gate_ci_passed", headSha: result.headSha };
      if (result.outcome === "ci_failed")
        return {
          type: "gate_ci_failed",
          headSha: result.headSha,
          reason: result.reason,
        };
      return null; // pending or stale — no state transition yet

    default: {
      const _exhaustive: never = result;
      console.error("[delivery-loop] unmapped effect result kind", {
        result: _exhaustive,
      });
      return null;
    }
  }
}

/**
 * Framework wrapper for state-blocking effects. Guarantees that every
 * handler execution produces exactly one event (or null for expected
 * no-transition cases). Handlers return EffectResult; they never
 * call kernel-advance APIs directly.
 */
async function executeStateBlockingEffect(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  leaseOwner: string;
  handler: () => Promise<EffectResult>;
}): Promise<void> {
  let result: EffectResult;
  try {
    result = await params.handler();
  } catch (error) {
    // Handler threw — create a typed failure result based on effect kind
    const reason = error instanceof Error ? error.message : String(error);
    const kind = parseEffectPayload(params.effect.payloadJson)?.kind;
    switch (kind) {
      case "create_plan_artifact":
        result = { kind: "create_plan_artifact", outcome: "failed", reason };
        break;
      case "dispatch_gate_review":
        result = { kind: "dispatch_gate_review", outcome: "failed", reason };
        break;
      case "ensure_pr":
        result = { kind: "ensure_pr", outcome: "failed", reason };
        break;
      case "dispatch_implementing":
        result = { kind: "dispatch_implementing", outcome: "failed", reason };
        break;
      case "run_lease_expiry_check":
        result = { kind: "run_lease_expiry_check", outcome: "stale" };
        break;
      case "ack_timeout_check":
        result = { kind: "ack_timeout_check", outcome: "stale" };
        break;
      case "gate_staleness_check":
        result = { kind: "gate_staleness_check", outcome: "stale" };
        break;
      default:
        throw error; // Unknown effect kind, let outer catch handle
    }
  }

  // Mark effect succeeded — the effect did its work regardless of outcome.
  // If lease ownership was lost (markEffectSucceeded returns false), suppress
  // the transition to prevent stale workers from mutating workflow state.
  const leaseStillHeld = await markEffectSucceeded({
    db: params.db,
    effectId: params.effect.id,
    leaseOwner: params.leaseOwner,
    leaseEpoch: params.effect.leaseEpoch,
  });

  if (!leaseStillHeld) {
    console.warn("[delivery-loop] lease lost during effect processing", {
      workflowId: params.effect.workflowId,
      effectId: params.effect.id,
      effectKind: result.kind,
    });
    return;
  }

  // Map result to event and fire if non-null
  const currentHead = await getWorkflowHead({
    db: params.db,
    workflowId: params.effect.workflowId,
  });
  if (currentHead?.version !== params.effect.workflowVersion) {
    console.warn(
      "[delivery-loop] suppressing stale state-blocking effect result",
      {
        workflowId: params.effect.workflowId,
        effectId: params.effect.id,
        effectKind: result.kind,
        effectWorkflowVersion: params.effect.workflowVersion,
        currentWorkflowVersion: currentHead?.version ?? null,
      },
    );
    return;
  }
  const eventRunSeq = currentHead.activeRunSeq;
  const event = effectResultToEvent(result, {
    activeRunSeq: eventRunSeq,
  });
  if (event) {
    try {
      await appendEventAndAdvanceExplicit({
        db: params.db,
        workflowId: params.effect.workflowId,
        source: "system",
        idempotencyKey: `effect-result:${params.effect.id}`,
        event,
        behavior: {
          applyGateBypass: false,
          drainEffects: false, // prevent recursive drain — outer drainDueEffects loop handles follow-on effects
        },
      });
    } catch (error) {
      // VAL-PROC-011: Prevent silent succeeded-without-transition state.
      // If transition append fails, mark the effect as failed so the system
      // will retry rather than leaving an unrecoverable silently-succeeded state.
      console.error(
        "[delivery-loop] effect transition append failed — marking effect for retry",
        {
          workflowId: params.effect.workflowId,
          effectId: params.effect.id,
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await markEffectFailed({
        db: params.db,
        effectId: params.effect.id,
        leaseOwner: params.leaseOwner,
        leaseEpoch: params.effect.leaseEpoch,
        errorCode: "transition_append_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        retryAt: addMilliseconds(params.now, 2_000),
      });
    }
  }
}

async function resolveThreadChatForDispatch(params: {
  db: DB;
  threadId: string;
}): Promise<ThreadChatRecord> {
  const threadChat =
    (await params.db.query.threadChat.findFirst({
      where: and(
        eq(schema.threadChat.threadId, params.threadId),
        ne(schema.threadChat.status, "complete"),
      ),
      orderBy: [desc(schema.threadChat.createdAt)],
    })) ??
    (await params.db.query.threadChat.findFirst({
      where: eq(schema.threadChat.threadId, params.threadId),
      orderBy: [desc(schema.threadChat.createdAt)],
    }));

  if (!threadChat) {
    throw new Error(`No threadChat for threadId ${params.threadId}`);
  }

  return threadChat;
}

async function persistDurableDispatchIntent(params: {
  db: DB;
  workflowId: string;
  threadId: string;
  threadChatId: string;
  runId: string;
  targetPhase: CreateDispatchIntentParams["targetPhase"];
  selectedAgent: CreateDispatchIntentParams["selectedAgent"];
  executionClass: CreateDispatchIntentParams["executionClass"];
}): Promise<PersistDispatchIntentResult> {
  try {
    await createDbDispatchIntent(params.db, {
      loopId: params.workflowId,
      threadId: params.threadId,
      threadChatId: params.threadChatId,
      runId: params.runId,
      targetPhase: params.targetPhase,
      selectedAgent: params.selectedAgent,
      executionClass: params.executionClass,
      dispatchMechanism: "self_dispatch",
    });
    await markDispatchIntentDispatched(params.db, params.runId);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Failed to persist durable dispatch intent (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

async function publishRealtimeDispatchIntentBestEffort(params: {
  scope: "review gate" | "implementing";
  workflowId: string;
  runId: string;
  intentParams: CreateDispatchIntentParams;
}): Promise<void> {
  try {
    await createDispatchIntent(params.intentParams);
  } catch (error) {
    console.warn(
      `[delivery-loop] failed to publish realtime dispatch intent for ${params.scope}`,
      {
        workflowId: params.workflowId,
        runId: params.runId,
        error: error instanceof Error ? error.message : error,
      },
    );
  }
}

async function launchDispatchFromIntent(params: {
  workflowId: string;
  workflow: DeliveryWorkflowRecord;
  threadChatId: string;
}): Promise<LaunchDispatchResult> {
  try {
    const dispatchResult = await launchDeliveryLoopDispatchFromIntent({
      userId: params.workflow.userId,
      threadId: params.workflow.threadId,
      threadChatId: params.threadChatId,
      workflowId: params.workflowId,
      bypassBusyCheck: true,
    });
    if (!dispatchResult.dispatchLaunched) {
      const cause = dispatchResult.reason;
      return {
        ok: false,
        reason: `Dispatch launch did not start (${cause})`,
        errorKind: "not_started",
        cause,
      };
    }
    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `Dispatch launch failed (${errorMessage})`,
      errorKind: "error",
      cause: errorMessage,
    };
  }
}

function buildRealtimeDispatchIntentParams(
  params: RealtimeDispatchIntentParamsInput,
): CreateDispatchIntentParams {
  return {
    loopId: params.workflowId,
    threadId: params.workflow.threadId,
    threadChatId: params.threadChatId,
    targetPhase: params.targetPhase,
    selectedAgent: params.selectedAgent,
    executionClass: params.executionClass,
    dispatchMechanism: "self_dispatch",
    runId: params.runId,
    maxRetries: 3,
    gate: params.gate,
    headSha: params.workflow.headSha ?? undefined,
  };
}

async function runDispatchEffectLaunchSequence(params: {
  db: DB;
  workflowId: string;
  scope: "review gate" | "implementing";
  targetPhase: CreateDispatchIntentParams["targetPhase"];
  executionClass: CreateDispatchIntentParams["executionClass"];
  gate?: CreateDispatchIntentParams["gate"];
  beforePersist?: (
    context: DispatchEffectLaunchContext,
  ) => Promise<void> | void;
}): Promise<DispatchEffectLaunchResult> {
  const workflow = await getWorkflow({
    db: params.db,
    workflowId: params.workflowId,
  });
  if (!workflow) {
    return {
      ok: false,
      reason: "Workflow not found",
    };
  }

  const threadChat = await resolveThreadChatForDispatch({
    db: params.db,
    threadId: workflow.threadId,
  });

  const runId = randomUUID();
  const context: DispatchEffectLaunchContext = {
    workflow,
    threadChat,
    runId,
  };

  await params.beforePersist?.(context);

  const durableIntent = await persistDurableDispatchIntent({
    db: params.db,
    workflowId: params.workflowId,
    threadId: workflow.threadId,
    threadChatId: threadChat.id,
    runId,
    targetPhase: params.targetPhase,
    selectedAgent: toSelectedAgent(threadChat.agent),
    executionClass: params.executionClass,
  });
  if (!durableIntent.ok) {
    console.warn("[delivery-loop] durable dispatch intent persistence failed", {
      workflowId: params.workflowId,
      threadId: workflow.threadId,
      threadChatId: threadChat.id,
      runId,
      error: durableIntent.reason,
    });
  }

  // Publish realtime dispatch intent best-effort; DB remains canonical.
  const intentParams = buildRealtimeDispatchIntentParams({
    workflowId: params.workflowId,
    workflow,
    threadChatId: threadChat.id,
    runId,
    targetPhase: params.targetPhase,
    selectedAgent: toSelectedAgent(threadChat.agent),
    executionClass: params.executionClass,
    gate: params.gate,
  });
  await publishRealtimeDispatchIntentBestEffort({
    scope: params.scope,
    workflowId: params.workflowId,
    runId,
    intentParams,
  });

  const launchResult = await launchDispatchFromIntent({
    workflowId: params.workflowId,
    workflow,
    threadChatId: threadChat.id,
  });

  if (!launchResult.ok) {
    return {
      ok: true,
      context,
      dispatchLaunched: false,
      reason: launchResult.reason,
      errorKind: launchResult.errorKind,
      cause: launchResult.cause,
    };
  }

  return {
    ok: true,
    context,
    dispatchLaunched: true,
  };
}

/**
 * Execute the `dispatch_gate_review` effect natively — resolves the workflow
 * context, persists a canonical dispatch intent, launches the gate run, and
 * emits dispatch lifecycle events into the v3 kernel.
 */
async function processGateReviewEffect(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  leaseOwner: string;
  gate: string;
  now: Date;
}): Promise<EffectResult> {
  const workflowId = params.effect.workflowId;
  const launchResult = await runDispatchEffectLaunchSequence({
    db: params.db,
    workflowId,
    scope: "review gate",
    targetPhase:
      `${params.gate}_gate` as CreateDispatchIntentParams["targetPhase"],
    gate: params.gate,
    executionClass: "gate_runtime",
  });

  if (!launchResult.ok) {
    return {
      kind: "dispatch_gate_review",
      outcome: "failed",
      reason: launchResult.reason,
    };
  }

  if (!launchResult.dispatchLaunched) {
    try {
      const followUpResult = await maybeProcessFollowUpQueue({
        userId: launchResult.context.workflow.userId,
        threadId: launchResult.context.workflow.threadId,
        threadChatId: launchResult.context.threadChat.id,
        bypassBusyCheck: true,
      });
      if (!followUpResult.dispatchLaunched) {
        return {
          kind: "dispatch_gate_review",
          outcome: "failed",
          reason: `Follow-up dispatch did not launch (${followUpResult.reason})`,
        };
      }
    } catch (error) {
      console.warn(
        "[delivery-loop] review gate follow-up queue trigger failed",
        {
          workflowId,
          runId: launchResult.context.runId,
          error: error instanceof Error ? error.message : error,
        },
      );
    }
    return {
      kind: "dispatch_gate_review",
      outcome: "dispatched",
      runId: launchResult.context.runId,
      ackDeadlineAt: new Date(params.now.getTime() + DEFAULT_ACK_TIMEOUT_MS),
    };
  }

  return {
    kind: "dispatch_gate_review",
    outcome: "dispatched",
    runId: launchResult.context.runId,
    ackDeadlineAt: new Date(params.now.getTime() + DEFAULT_ACK_TIMEOUT_MS),
  };
}

/**
 * Execute the `dispatch_implementing` effect natively — resolves the workflow
 * context, creates a dispatch intent for the implementation sandbox run,
 * launches the dispatch run, and emits dispatch lifecycle events into the
 * v3 kernel.
 */
async function processImplementingDispatchEffect(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  leaseOwner: string;
  executionClass: "implementation_runtime" | "implementation_runtime_fallback";
  retryReason?: string | null;
  now: Date;
}): Promise<EffectResult> {
  const workflowId = params.effect.workflowId;
  const launchResult = await runDispatchEffectLaunchSequence({
    db: params.db,
    workflowId,
    scope: "implementing",
    targetPhase: "implementing",
    executionClass: params.executionClass,
    beforePersist: async ({ workflow }) => {
      if (process.env.DELIVERY_LOOP_DEBUG === "true") {
        console.log("[delivery-loop] processImplementingDispatchEffect start", {
          workflowId,
          threadId: workflow.threadId,
          generation:
            (await getWorkflowHead({ db: params.db, workflowId }))
              ?.generation ?? 0,
        });
      }
    },
  });

  if (!launchResult.ok) {
    return {
      kind: "dispatch_implementing",
      outcome: "failed",
      reason: launchResult.reason,
    };
  }

  if (!launchResult.dispatchLaunched) {
    if (launchResult.errorKind === "error") {
      // Preserve legacy behavior: transient follow-up trigger exceptions are
      // non-fatal because durable dispatch intent is already persisted.
      console.warn(
        "[delivery-loop] follow-up queue trigger failed (non-fatal)",
        {
          workflowId,
          runId: launchResult.context.runId,
          error: launchResult.cause ?? launchResult.reason,
        },
      );
      return {
        kind: "dispatch_implementing",
        outcome: "dispatched",
        runId: launchResult.context.runId,
        ackDeadlineAt: new Date(params.now.getTime() + DEFAULT_ACK_TIMEOUT_MS),
      };
    }

    return {
      kind: "dispatch_implementing",
      outcome: "failed",
      reason: launchResult.reason,
    };
  }

  try {
    await syncThreadStatusForImplementationDispatch({
      db: params.db,
      threadId: launchResult.context.workflow.threadId,
    });
  } catch (error) {
    console.warn("[delivery-loop] implementation thread status sync failed", {
      workflowId,
      runId: launchResult.context.runId,
      error: error instanceof Error ? error.message : error,
    });
  }

  const ackDeadlineAt = new Date(params.now.getTime() + DEFAULT_ACK_TIMEOUT_MS);
  console.log("[delivery-loop] dispatch_implementing effect complete", {
    workflowId,
    runId: launchResult.context.runId,
    ackDeadlineAt: ackDeadlineAt.toISOString(),
    isRetry: params.retryReason != null,
  });

  return {
    kind: "dispatch_implementing",
    outcome: "dispatched",
    runId: launchResult.context.runId,
    ackDeadlineAt,
  };
}

async function syncThreadStatusForImplementationDispatch(params: {
  db: DB;
  threadId: string;
}): Promise<void> {
  // Keep thread-level status aligned with workflow-level implementing state.
  await params.db
    .update(schema.thread)
    .set({ status: "working", updatedAt: new Date() })
    .where(eq(schema.thread.id, params.threadId));
}

const STATE_LABELS: Record<string, string> = {
  planning: "Planning phase in progress",
  implementing: "Implementation in progress",
  gating_review: "Waiting on review gate",
  gating_ci: "Waiting on CI gate",
  awaiting_pr_creation: "Awaiting PR creation",
  awaiting_pr_lifecycle: "Awaiting PR review lifecycle",
  awaiting_manual_fix: "Awaiting manual fix from human",
  awaiting_operator_action: "Awaiting operator action",
  done: "Delivery loop completed",
  stopped: "Delivery loop stopped",
  terminated: "Delivery loop terminated",
};

function formatStatusBodyV3(state: string): string {
  const label = STATE_LABELS[state] ?? `State: ${state}`;
  return `Terragon Delivery Loop status update.\n\n- Current state: \`${state}\`\n- ${label}`;
}

async function processPublishStatusEffect(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  leaseOwner: string;
  now: Date;
}): Promise<void> {
  const workflow = await getWorkflow({
    db: params.db,
    workflowId: params.effect.workflowId,
  });
  if (!workflow || typeof workflow.prNumber !== "number") {
    await markEffectSucceeded({
      db: params.db,
      effectId: params.effect.id,
      leaseOwner: params.leaseOwner,
      leaseEpoch: params.effect.leaseEpoch,
    });
    return;
  }

  const head = await getWorkflowHead({
    db: params.db,
    workflowId: params.effect.workflowId,
  });
  const currentState = head?.state ?? workflow.kind;
  const body = formatStatusBodyV3(currentState);
  const isTerminal = isTerminalState(currentState as WorkflowState);

  try {
    await upsertDeliveryCanonicalStatusComment({
      db: params.db,
      workflowId: workflow.id,
      repoFullName: workflow.repoFullName,
      prNumber: workflow.prNumber,
      body,
    });
    await upsertDeliveryCanonicalCheckSummary({
      db: params.db,
      workflowId: workflow.id,
      payload: {
        repoFullName: workflow.repoFullName,
        prNumber: workflow.prNumber,
        title: "Terragon Delivery Loop",
        summary: body,
        status: isTerminal ? "completed" : "in_progress",
        conclusion:
          currentState === "done"
            ? "success"
            : currentState === "stopped" || currentState === "terminated"
              ? "cancelled"
              : undefined,
      },
    });
  } catch (pubErr) {
    const classified = classifyDeliveryPublicationFailure(pubErr);
    if (!classified.retriable) {
      await markEffectSucceeded({
        db: params.db,
        effectId: params.effect.id,
        leaseOwner: params.leaseOwner,
        leaseEpoch: params.effect.leaseEpoch,
      });
      return;
    }
    throw pubErr;
  }

  await markEffectSucceeded({
    db: params.db,
    effectId: params.effect.id,
    leaseOwner: params.leaseOwner,
    leaseEpoch: params.effect.leaseEpoch,
  });
}

async function processEnsurePrEffect(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  leaseOwner: string;
}): Promise<EffectResult> {
  const workflow = await getWorkflow({
    db: params.db,
    workflowId: params.effect.workflowId,
  });
  if (!workflow) {
    return {
      kind: "ensure_pr",
      outcome: "failed",
      reason: "Workflow not found",
    };
  }

  const head = await getWorkflowHead({
    db: params.db,
    workflowId: params.effect.workflowId,
  });
  if (!head || head.state !== "awaiting_pr_creation") {
    return {
      kind: "ensure_pr",
      outcome: "failed",
      reason: "Workflow not in awaiting_pr_creation state",
    };
  }

  if (typeof workflow.prNumber === "number") {
    return {
      kind: "ensure_pr",
      outcome: "linked",
      prNumber: workflow.prNumber,
    };
  }

  const [{ withThreadSandboxSession }, { openPullRequestForThread }] =
    await Promise.all([
      import("@/agent/thread-resource"),
      import("@/agent/pull-request"),
    ]);
  let prType: "draft" | "ready" = "draft";
  if (workflow.userId) {
    const { getUserSettings } = await import("@terragon/shared/model/user");
    const userSettings = await getUserSettings({
      db: params.db,
      userId: workflow.userId,
    });
    prType = userSettings.prType;
  }
  const latestThreadChat = await params.db.query.threadChat.findFirst({
    where: eq(schema.threadChat.threadId, workflow.threadId),
    columns: { id: true },
    orderBy: [desc(schema.threadChat.createdAt)],
  });
  let surfacedError: Error | null = null;

  const didOpenPr = await withThreadSandboxSession({
    label: "delivery-loop-v3-ensure-pr",
    threadId: workflow.threadId,
    threadChatId: latestThreadChat?.id ?? null,
    userId: workflow.userId,
    onError: async (error) => {
      surfacedError = error;
    },
    execOrThrow: async ({ session }) => {
      if (!session) {
        throw new Error(
          `No sandbox session available for thread ${workflow.threadId}`,
        );
      }
      await openPullRequestForThread({
        threadId: workflow.threadId,
        userId: workflow.userId,
        threadChatId: latestThreadChat?.id ?? null,
        skipCommitAndPush: false,
        prType,
        session,
      });
      return true;
    },
  });
  if (!didOpenPr) {
    throw (
      surfacedError ??
      new Error(
        `openPullRequestForThread did not complete for thread ${workflow.threadId}`,
      )
    );
  }

  const refreshedWorkflow = await getWorkflow({
    db: params.db,
    workflowId: params.effect.workflowId,
  });
  if (!refreshedWorkflow || typeof refreshedWorkflow.prNumber !== "number") {
    throw new Error(
      `PR linkage missing after ensure_pr for workflow ${params.effect.workflowId}`,
    );
  }

  return {
    kind: "ensure_pr",
    outcome: "linked",
    prNumber: refreshedWorkflow.prNumber,
  };
}

async function handleCreatePlanArtifact(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  now: Date;
}): Promise<EffectResult> {
  const head = await getWorkflowHead({
    db: params.db,
    workflowId: params.effect.workflowId,
  });
  if (!head) {
    return {
      kind: "create_plan_artifact",
      outcome: "failed",
      reason: "Workflow head not found",
    };
  }

  const threadChat = await params.db.query.threadChat.findFirst({
    where: eq(schema.threadChat.threadId, head.threadId),
    columns: { messages: true },
    orderBy: [desc(schema.threadChat.createdAt)],
  });

  if (!threadChat?.messages) {
    return {
      kind: "create_plan_artifact",
      outcome: "failed",
      reason: "No thread chat messages found",
    };
  }

  const extracted = extractLatestPlanText(
    threadChat.messages as Parameters<typeof extractLatestPlanText>[0],
  );
  if (!extracted) {
    return {
      kind: "create_plan_artifact",
      outcome: "failed",
      reason: "No plan text found in messages",
    };
  }

  const parseResult = parsePlanSpec(extracted.text);
  if (!parseResult.ok) {
    return {
      kind: "create_plan_artifact",
      outcome: "failed",
      reason: "Plan parsing failed",
    };
  }

  const planPayload = {
    planText: parseResult.plan.planText,
    tasks: parseResult.plan.tasks,
    source: (extracted.source as PlanSpecSource) ?? "system",
  };
  const artifact = await createPlanArtifact({
    db: params.db,
    loopId: params.effect.workflowId,
    loopVersion: head.version,
    status: "accepted",
    generatedBy: "agent",
    workflowId: params.effect.workflowId,
    payload: planPayload,
    now: params.now,
  });
  await replacePlanTasksForArtifact({
    db: params.db,
    loopId: params.effect.workflowId,
    artifactId: artifact.id,
    tasks: parseResult.plan.tasks,
    now: params.now,
  });

  const workflow = await getWorkflow({
    db: params.db,
    workflowId: params.effect.workflowId,
  });
  return {
    kind: "create_plan_artifact",
    outcome: "created",
    approvalPolicy: normalizeEffectApprovalPolicy(workflow?.planApprovalPolicy),
  };
}

async function handleRunLeaseExpiryCheck(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  payload: Extract<
    EffectPayload,
    { kind: "run_lease_expiry_check" | "ack_timeout_check" }
  >;
}): Promise<EffectResult> {
  const staleResult =
    params.payload.kind === "run_lease_expiry_check"
      ? ({ kind: "run_lease_expiry_check", outcome: "stale" } as const)
      : ({ kind: "ack_timeout_check", outcome: "stale" } as const);
  const firedResult = {
    kind: params.payload.kind,
    outcome: "fired",
    runId: params.payload.runId,
  } as const;
  const [head, workflow] = await Promise.all([
    getWorkflowHead({ db: params.db, workflowId: params.effect.workflowId }),
    getWorkflow({ db: params.db, workflowId: params.effect.workflowId }),
  ]);
  if (!head || head.version !== params.payload.workflowVersion) {
    return staleResult;
  }

  if (
    head.state !== "implementing" &&
    head.state !== "awaiting_implementation_acceptance"
  ) {
    return staleResult;
  }

  const hasMatchingLease =
    head.leaseExpiresAt !== null &&
    head.leaseExpiresAt.getTime() <= params.effect.dueAt.getTime();
  const isLegacyAckTimeout = params.payload.kind === "ack_timeout_check";
  if (
    head.activeRunId !== params.payload.runId ||
    (!hasMatchingLease && !isLegacyAckTimeout)
  ) {
    return staleResult;
  }

  if (workflow) {
    const { getAgentRunContextByRunId } = await import(
      "@terragon/shared/model/agent-run-context"
    );
    const runContext = await getAgentRunContextByRunId({
      db: params.db,
      runId: params.payload.runId,
      userId: workflow.userId,
    });
    if (runContext && ACTIVE_RUN_CONTEXT_STATUSES.has(runContext.status)) {
      return staleResult;
    }
  }

  return firedResult;
}

const MAX_GATE_STALENESS_POLLS = 50;

async function handleGateStalenessCheck(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  payload: { workflowVersion: number; pollCount?: number };
  now: Date;
}): Promise<EffectResult> {
  const pollCount = params.payload.pollCount ?? 0;

  if (pollCount >= MAX_GATE_STALENESS_POLLS) {
    return { kind: "gate_staleness_check", outcome: "stale" } as const;
  }

  const [head, workflow] = await Promise.all([
    getWorkflowHead({ db: params.db, workflowId: params.effect.workflowId }),
    getWorkflow({ db: params.db, workflowId: params.effect.workflowId }),
  ]);

  if (!head || head.version !== params.payload.workflowVersion) {
    return { kind: "gate_staleness_check", outcome: "stale" } as const;
  }
  if (!workflow || !head.headSha) {
    return { kind: "gate_staleness_check", outcome: "stale" } as const;
  }

  const repoFullName = workflow.repoFullName;
  if (!repoFullName) {
    return { kind: "gate_staleness_check", outcome: "stale" } as const;
  }

  try {
    const { fetchCiSignalSnapshotForHeadSha } = await import(
      "@/app/api/webhooks/github/handlers"
    );
    const snapshot = await fetchCiSignalSnapshotForHeadSha({
      repoFullName,
      headSha: head.headSha,
    });
    if (process.env.DELIVERY_LOOP_DEBUG === "true") {
      const snapshotSummary = snapshot
        ? {
            complete: snapshot.complete,
            failingCount: snapshot.failingChecks?.length ?? 0,
            failingChecks: snapshot.failingChecks ?? [],
          }
        : null;
      console.log(
        "[gate_staleness_check] snapshot summary:",
        snapshotSummary,
        "headSha:",
        head.headSha,
        "repo:",
        repoFullName,
      );
    }

    if (!snapshot) {
      // No check runs yet — re-enqueue for another poll in 5 min
      await insertEffects({
        db: params.db,
        workflowId: params.effect.workflowId,
        workflowVersion: head.version,
        effects: [
          {
            kind: "gate_staleness_check",
            effectKey: `${params.effect.workflowId}:${head.version}:gate_staleness_check:${Date.now()}`,
            dueAt: new Date(params.now.getTime() + 5 * 60 * 1000),
            payload: {
              kind: "gate_staleness_check",
              workflowVersion: head.version,
              pollCount: pollCount + 1,
            },
          },
        ],
      });
      return { kind: "gate_staleness_check", outcome: "pending" } as const;
    }

    if (snapshot.failingChecks.length > 0) {
      return {
        kind: "gate_staleness_check",
        outcome: "ci_failed",
        headSha: head.headSha,
        reason: `CI checks failed: ${snapshot.failingChecks.join(", ")}`,
      } as const;
    }

    if (snapshot.complete) {
      return {
        kind: "gate_staleness_check",
        outcome: "ci_passed",
        headSha: head.headSha,
      } as const;
    }

    // Still pending — re-enqueue for another poll in 5 min
    await insertEffects({
      db: params.db,
      workflowId: params.effect.workflowId,
      workflowVersion: head.version,
      effects: [
        {
          kind: "gate_staleness_check",
          effectKey: `${params.effect.workflowId}:${head.version}:gate_staleness_check:${Date.now()}`,
          dueAt: new Date(params.now.getTime() + 5 * 60 * 1000),
          payload: {
            kind: "gate_staleness_check",
            workflowVersion: head.version,
            pollCount: pollCount + 1,
          },
        },
      ],
    });
    return { kind: "gate_staleness_check", outcome: "pending" } as const;
  } catch (err) {
    console.error("[gate_staleness_check] transient error, re-enqueuing", {
      workflowId: params.effect.workflowId,
      version: params.payload.workflowVersion,
      pollCount,
      error: err instanceof Error ? err.message : err,
    });
    // Re-enqueue on transient errors rather than treating as stale.
    // Use head.version (not params.payload.workflowVersion) so the
    // re-enqueued effect isn't immediately stale if the version advanced.
    const retryVersion = head?.version ?? params.payload.workflowVersion;
    await insertEffects({
      db: params.db,
      workflowId: params.effect.workflowId,
      workflowVersion: retryVersion,
      effects: [
        {
          kind: "gate_staleness_check",
          effectKey: `${params.effect.workflowId}:${retryVersion}:gate_staleness_check:${Date.now()}`,
          dueAt: new Date(params.now.getTime() + 5 * 60 * 1000),
          payload: {
            kind: "gate_staleness_check",
            workflowVersion: retryVersion,
            pollCount: pollCount + 1,
          },
        },
      ],
    });
    return { kind: "gate_staleness_check", outcome: "pending" } as const;
  }
}

async function processSingleEffect(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  leaseOwner: string;
  now: Date;
}) {
  const payload = parseEffectPayload(params.effect.payloadJson);
  if (!payload) {
    await markEffectFailed({
      db: params.db,
      effectId: params.effect.id,
      leaseOwner: params.leaseOwner,
      leaseEpoch: params.effect.leaseEpoch,
      errorCode: "invalid_payload",
      errorMessage: "Unsupported effect payload",
      retryAt: addMilliseconds(params.now, 5_000),
    });
    return;
  }

  try {
    if (payload.kind === "dispatch_implementing") {
      await executeStateBlockingEffect({
        db: params.db,
        effect: params.effect,
        leaseOwner: params.leaseOwner,
        handler: () =>
          processImplementingDispatchEffect({
            db: params.db,
            effect: params.effect,
            leaseOwner: params.leaseOwner,
            executionClass: payload.executionClass,
            retryReason: payload.retryReason,
            now: params.now,
          }),
      });
      return;
    }

    if (payload.kind === "dispatch_gate_review") {
      await executeStateBlockingEffect({
        db: params.db,
        effect: params.effect,
        leaseOwner: params.leaseOwner,
        handler: () =>
          processGateReviewEffect({
            db: params.db,
            effect: params.effect,
            leaseOwner: params.leaseOwner,
            gate: payload.gate,
            now: params.now,
          }),
      });
      return;
    }

    if (payload.kind === "ensure_pr") {
      await executeStateBlockingEffect({
        db: params.db,
        effect: params.effect,
        leaseOwner: params.leaseOwner,
        handler: () =>
          processEnsurePrEffect({
            db: params.db,
            effect: params.effect,
            leaseOwner: params.leaseOwner,
          }),
      });
      return;
    }

    if (payload.kind === "publish_status") {
      await processPublishStatusEffect({
        db: params.db,
        effect: params.effect,
        leaseOwner: params.leaseOwner,
        now: params.now,
      });
      return;
    }

    if (payload.kind === "create_plan_artifact") {
      await executeStateBlockingEffect({
        db: params.db,
        effect: params.effect,
        leaseOwner: params.leaseOwner,
        handler: () =>
          handleCreatePlanArtifact({
            db: params.db,
            effect: params.effect,
            now: params.now,
          }),
      });
      return;
    }

    if (
      payload.kind === "run_lease_expiry_check" ||
      payload.kind === "ack_timeout_check"
    ) {
      await executeStateBlockingEffect({
        db: params.db,
        effect: params.effect,
        leaseOwner: params.leaseOwner,
        handler: () =>
          handleRunLeaseExpiryCheck({
            db: params.db,
            effect: params.effect,
            payload,
          }),
      });
      return;
    }

    if (payload.kind === "gate_staleness_check") {
      await executeStateBlockingEffect({
        db: params.db,
        effect: params.effect,
        leaseOwner: params.leaseOwner,
        handler: () =>
          handleGateStalenessCheck({
            db: params.db,
            effect: params.effect,
            payload,
            now: params.now,
          }),
      });
      return;
    }
  } catch (error) {
    await markEffectFailed({
      db: params.db,
      effectId: params.effect.id,
      leaseOwner: params.leaseOwner,
      leaseEpoch: params.effect.leaseEpoch,
      errorCode: "effect_handler_threw",
      errorMessage: error instanceof Error ? error.message : String(error),
      retryAt: addMilliseconds(params.now, 2_000),
    });
  }
}

export async function drainDueEffects(params: {
  db: DB;
  workflowId?: string;
  maxItems?: number;
  leaseOwnerPrefix?: string;
  now?: Date;
}): Promise<{ processed: number }> {
  const maxItems = params.maxItems ?? 25;
  const leaseOwnerPrefix = params.leaseOwnerPrefix ?? "cron:v3";
  const now = params.now ?? new Date();

  let processed = 0;
  for (let i = 0; i < maxItems; i++) {
    const leaseOwner = `${leaseOwnerPrefix}:${crypto.randomUUID()}`;
    const effect = await claimNextEffect({
      db: params.db,
      leaseOwner,
      workflowId: params.workflowId,
      now,
    });
    if (!effect) break;
    await processSingleEffect({
      db: params.db,
      effect,
      leaseOwner,
      now,
    });
    processed++;
  }
  return { processed };
}

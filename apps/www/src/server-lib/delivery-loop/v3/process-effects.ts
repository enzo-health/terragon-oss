import { and, eq, ne, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DB } from "@terragon/shared/db";
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
import { appendEventAndAdvance } from "./kernel";
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
import { toSelectedAgent } from "@terragon/shared/delivery-loop/domain/dispatch-types";
import {
  AWAITING_PR_CREATION_REASON,
  isTerminalState,
  type EffectResult,
  type LoopEvent,
  type WorkflowState,
} from "./types";

function summarizeRetryReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 180)}...`;
}

/**
 * Pure mapping from effect result to the LoopEvent that should be fired.
 * Returns null for results that don't require a state transition (e.g., human
 * approval pending, stale ack timeout).
 */
export function effectResultToEvent(result: EffectResult): LoopEvent | null {
  switch (result.kind) {
    case "create_plan_artifact":
      if (result.outcome === "created" && result.approvalPolicy === "auto")
        return { type: "plan_completed" };
      if (result.outcome === "created") return null; // Human approval — UI fires plan_completed
      return { type: "plan_failed", reason: result.reason };

    case "dispatch_gate_review":
      if (result.outcome === "dispatched")
        return {
          type: "dispatch_sent",
          runId: result.runId,
          ackDeadlineAt: result.ackDeadlineAt,
        };
      return {
        type: "run_failed",
        runId: `gate-dispatch-failed-${Date.now()}`,
        message: result.reason,
        category: "effect_failure",
        lane: "infra",
      };

    case "ensure_pr":
      if (result.outcome === "linked")
        return { type: "pr_linked", prNumber: result.prNumber };
      return { type: "gate_review_failed", reason: result.reason };

    case "dispatch_implementing":
      if (result.outcome === "dispatched")
        return {
          type: "dispatch_sent",
          runId: result.runId,
          ackDeadlineAt: result.ackDeadlineAt,
        };
      return {
        type: "run_failed",
        runId: `impl-dispatch-failed-${Date.now()}`,
        message: result.reason,
        category: "effect_failure",
        lane: "infra",
      };

    case "ack_timeout_check":
      if (result.outcome === "fired")
        return { type: "dispatch_ack_timeout", runId: result.runId };
      return null; // Stale timeout, version already advanced

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
 * call appendEventAndAdvance directly.
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

  // Mark effect succeeded — the effect did its work regardless of outcome
  await markEffectSucceeded({
    db: params.db,
    effectId: params.effect.id,
    leaseOwner: params.leaseOwner,
    leaseEpoch: params.effect.leaseEpoch,
  });

  // Map result to event and fire if non-null
  const event = effectResultToEvent(result);
  if (event) {
    await appendEventAndAdvance({
      db: params.db,
      workflowId: params.effect.workflowId,
      source: "system",
      idempotencyKey: `effect-result:${params.effect.id}`,
      event,
      eagerDrain: false, // prevent recursive drain — outer drainDueEffects loop handles follow-on effects
    });
  }
}

/**
 * Execute the `dispatch_gate_review` effect natively — resolves the workflow
 * context, creates a dispatch intent for the gate sandbox run, triggers the
 * follow-up queue, and emits `dispatch_sent` into the v3 kernel.
 *
 * This replaces the v2 work-queue bridge, keeping the full lifecycle within
 * the v3 effect ledger.
 */
async function processGateReviewEffect(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  leaseOwner: string;
  gate: string;
  now: Date;
}): Promise<EffectResult> {
  const workflowId = params.effect.workflowId;

  const workflow = await getWorkflow({ db: params.db, workflowId });
  if (!workflow) {
    return {
      kind: "dispatch_gate_review",
      outcome: "failed",
      reason: "Workflow not found",
    };
  }

  // Resolve threadChat (prefer active, fall back to most-recent)
  const threadChat =
    (await params.db.query.threadChat.findFirst({
      where: and(
        eq(schema.threadChat.threadId, workflow.threadId),
        ne(schema.threadChat.status, "complete"),
      ),
      orderBy: [desc(schema.threadChat.createdAt)],
    })) ??
    (await params.db.query.threadChat.findFirst({
      where: eq(schema.threadChat.threadId, workflow.threadId),
      orderBy: [desc(schema.threadChat.createdAt)],
    }));

  if (!threadChat) {
    throw new Error(`No threadChat for threadId ${workflow.threadId}`);
  }

  const runId = randomUUID();
  const targetPhase = `${params.gate}_gate` as const;

  // Create Redis dispatch intent
  const intentParams: CreateDispatchIntentParams = {
    loopId: workflowId,
    threadId: workflow.threadId,
    threadChatId: threadChat.id,
    targetPhase: targetPhase as CreateDispatchIntentParams["targetPhase"],
    selectedAgent: toSelectedAgent(threadChat.agent),
    executionClass: "gate_runtime",
    dispatchMechanism: "self_dispatch",
    runId,
    maxRetries: 3,
    gate: params.gate,
    headSha: workflow.headSha ?? undefined,
  };

  await createDispatchIntent(intentParams);

  // Persist durable dispatch intent in DB
  try {
    await createDbDispatchIntent(params.db, {
      loopId: workflowId,
      threadId: workflow.threadId,
      threadChatId: threadChat.id,
      runId,
      targetPhase: targetPhase as CreateDispatchIntentParams["targetPhase"],
      selectedAgent: toSelectedAgent(threadChat.agent),
      executionClass: "gate_runtime",
      dispatchMechanism: "self_dispatch",
    });
    await markDispatchIntentDispatched(params.db, runId);
  } catch {
    // Non-fatal: Redis intent + cron sweep handle recovery
  }

  // Queue a "Continue gate check." message for the follow-up queue,
  // but only on retries — on the first gate run the prior context is sufficient.
  const head = await getWorkflowHead({ db: params.db, workflowId });
  const isRetry =
    !!head &&
    (head.fixAttemptCount > 0 ||
      head.infraRetryCount > 0 ||
      head.generation > 1);
  if (isRetry) {
    const { updateThreadChat } = await import("@terragon/shared/model/threads");
    await updateThreadChat({
      db: params.db,
      userId: workflow.userId,
      threadId: workflow.threadId,
      threadChatId: threadChat.id,
      updates: {
        appendQueuedMessages: [
          {
            type: "user" as const,
            model: null,
            timestamp: new Date().toISOString(),
            parts: [{ type: "text" as const, text: "Continue gate check." }],
          },
        ],
      },
    });
  }

  // Trigger the follow-up queue to launch the sandbox run.
  // This is best-effort — the dispatch intent + queued message are already
  // persisted, so the cron will pick them up even if this fails.
  try {
    const { maybeProcessFollowUpQueue } = await import(
      "@/server-lib/process-follow-up-queue"
    );
    await maybeProcessFollowUpQueue({
      userId: workflow.userId,
      threadId: workflow.threadId,
      threadChatId: threadChat.id,
      bypassBusyCheck: true,
    });
  } catch {
    // Non-fatal: cron will pick up pending follow-ups
  }

  return {
    kind: "dispatch_gate_review",
    outcome: "dispatched",
    runId,
    ackDeadlineAt: new Date(params.now.getTime() + DEFAULT_ACK_TIMEOUT_MS),
  };
}

/**
 * Execute the `dispatch_implementing` effect natively — resolves the workflow
 * context, creates a dispatch intent for the implementation sandbox run,
 * triggers the follow-up queue, and emits `dispatch_sent` into the v3 kernel.
 *
 * This replaces the v2 work-queue bridge, keeping the full lifecycle within
 * the v3 effect ledger.
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

  const workflow = await getWorkflow({ db: params.db, workflowId });
  if (!workflow) {
    return {
      kind: "dispatch_implementing",
      outcome: "failed",
      reason: "Workflow not found",
    };
  }

  // Resolve threadChat (prefer active, fall back to most-recent)
  const threadChat =
    (await params.db.query.threadChat.findFirst({
      where: and(
        eq(schema.threadChat.threadId, workflow.threadId),
        ne(schema.threadChat.status, "complete"),
      ),
      orderBy: [desc(schema.threadChat.createdAt)],
    })) ??
    (await params.db.query.threadChat.findFirst({
      where: eq(schema.threadChat.threadId, workflow.threadId),
      orderBy: [desc(schema.threadChat.createdAt)],
    }));

  if (!threadChat) {
    throw new Error(`No threadChat for threadId ${workflow.threadId}`);
  }

  // Resolve retry/generation info early for logging
  const head = await getWorkflowHead({ db: params.db, workflowId });
  const isRetry =
    !!head &&
    (head.fixAttemptCount > 0 ||
      head.infraRetryCount > 0 ||
      head.generation > 1);

  const runId = randomUUID();

  if (process.env.DELIVERY_LOOP_DEBUG === "true") {
    console.log("[delivery-loop] processImplementingDispatchEffect start", {
      workflowId,
      threadId: workflow.threadId,
      isRetry,
      generation: head?.generation ?? 0,
    });
  }

  // Create Redis dispatch intent
  const intentParams: CreateDispatchIntentParams = {
    loopId: workflowId,
    threadId: workflow.threadId,
    threadChatId: threadChat.id,
    targetPhase: "implementing",
    selectedAgent: toSelectedAgent(threadChat.agent),
    executionClass: params.executionClass,
    dispatchMechanism: "self_dispatch",
    runId,
    maxRetries: 3,
    headSha: workflow.headSha ?? undefined,
  };

  await createDispatchIntent(intentParams);

  // Persist durable dispatch intent in DB
  try {
    await createDbDispatchIntent(params.db, {
      loopId: workflowId,
      threadId: workflow.threadId,
      threadChatId: threadChat.id,
      runId,
      targetPhase: "implementing",
      selectedAgent: toSelectedAgent(threadChat.agent),
      executionClass: params.executionClass,
      dispatchMechanism: "self_dispatch",
    });
    await markDispatchIntentDispatched(params.db, runId);
  } catch (dbIntentErr) {
    console.warn(
      "[delivery-loop] DB dispatch intent persistence failed (non-fatal)",
      {
        workflowId,
        runId,
        error: dbIntentErr instanceof Error ? dbIntentErr.message : dbIntentErr,
      },
    );
  }

  // Always queue a message so maybeProcessFollowUpQueue has something to
  // dispatch.  Without this the first post-planning run gets orphaned because
  // the follow-up queue finds an empty queuedMessages array and returns early.
  {
    const messageText = isRetry
      ? params.retryReason
        ? `Previous attempt failed: ${summarizeRetryReason(params.retryReason)}. Fix the issue and continue implementation.`
        : "Continue implementation."
      : "Begin implementation.";
    const { updateThreadChat } = await import("@terragon/shared/model/threads");
    await updateThreadChat({
      db: params.db,
      userId: workflow.userId,
      threadId: workflow.threadId,
      threadChatId: threadChat.id,
      updates: {
        appendQueuedMessages: [
          {
            type: "user" as const,
            model: null,
            timestamp: new Date().toISOString(),
            parts: [{ type: "text" as const, text: messageText }],
          },
        ],
      },
    });
  }

  // Trigger the follow-up queue to launch the sandbox run — but only when the
  // sandbox is already up.  During initial bootstrap the threadChat is still in
  // booting/queued while startAgentMessage is actively creating the sandbox.
  // Calling maybeProcessFollowUpQueue in that state spawns a second
  // startAgentMessage that races the first and fails with sandbox-not-found.
  // The queued message is still persisted so the original startAgentMessage
  // picks it up after sandbox boot or the cron drains it.
  const chatStatus = threadChat.status;
  const sandboxAlreadyRunning =
    chatStatus === "working" ||
    chatStatus === "working-done" ||
    chatStatus === "complete" ||
    chatStatus === "stopping" ||
    chatStatus === "checkpointing";
  if (sandboxAlreadyRunning) {
    try {
      const { maybeProcessFollowUpQueue } = await import(
        "@/server-lib/process-follow-up-queue"
      );
      await maybeProcessFollowUpQueue({
        userId: workflow.userId,
        threadId: workflow.threadId,
        threadChatId: threadChat.id,
        bypassBusyCheck: true,
      });
    } catch (followUpErr) {
      console.warn(
        "[delivery-loop] follow-up queue trigger failed (non-fatal)",
        {
          workflowId,
          runId,
          error:
            followUpErr instanceof Error ? followUpErr.message : followUpErr,
        },
      );
    }
  } else {
    console.log(
      "[delivery-loop] skipping eager follow-up dispatch — sandbox still booting",
      { workflowId, runId, chatStatus },
    );
  }

  const ackDeadlineAt = new Date(params.now.getTime() + DEFAULT_ACK_TIMEOUT_MS);
  console.log("[delivery-loop] dispatch_implementing effect complete", {
    workflowId,
    runId,
    ackDeadlineAt: ackDeadlineAt.toISOString(),
    isRetry,
  });

  return {
    kind: "dispatch_implementing",
    outcome: "dispatched",
    runId,
    ackDeadlineAt,
  };
}

const STATE_LABELS: Record<string, string> = {
  planning: "Planning phase in progress",
  implementing: "Implementation in progress",
  gating_review: "Waiting on review gate",
  gating_ci: "Waiting on CI gate",
  awaiting_pr: "Awaiting PR review",
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
  if (
    !head ||
    head.state !== "awaiting_pr" ||
    head.blockedReason !== AWAITING_PR_CREATION_REASON
  ) {
    return {
      kind: "ensure_pr",
      outcome: "failed",
      reason: "Workflow not in awaiting_pr state",
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
    approvalPolicy:
      (workflow?.planApprovalPolicy as "auto" | "human") ?? "auto",
  };
}

async function handleAckTimeoutCheck(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  payload: { runId: string; workflowVersion: number };
}): Promise<EffectResult> {
  const [head, workflow] = await Promise.all([
    getWorkflowHead({ db: params.db, workflowId: params.effect.workflowId }),
    getWorkflow({ db: params.db, workflowId: params.effect.workflowId }),
  ]);
  if (!head || head.version !== params.payload.workflowVersion) {
    return { kind: "ack_timeout_check", outcome: "stale" };
  }

  // If the daemon has actually started processing THIS run, the ack timeout
  // is a false alarm.  We verify by checking the agent_run_context table —
  // a row only exists after startAgentMessage delivers the run to the daemon.
  // Previously we checked threadChat.status === "working", but that can be
  // stale from a PRIOR run, causing false suppression and a permanent stuck
  // state when the new dispatch never reached the daemon.
  if (workflow) {
    const { getAgentRunContextByRunId } = await import(
      "@terragon/shared/model/agent-run-context"
    );
    const runContext = await getAgentRunContextByRunId({
      db: params.db,
      runId: params.payload.runId,
      userId: workflow.userId,
    });
    if (
      runContext &&
      (runContext.status === "pending" ||
        runContext.status === "dispatched" ||
        runContext.status === "processing")
    ) {
      // The daemon genuinely has this run — suppress the timeout
      return { kind: "ack_timeout_check", outcome: "stale" };
    }
  }

  return {
    kind: "ack_timeout_check",
    outcome: "fired",
    runId: params.payload.runId,
  };
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

    // ack_timeout_check
    if (payload.kind === "ack_timeout_check") {
      await executeStateBlockingEffect({
        db: params.db,
        effect: params.effect,
        leaseOwner: params.leaseOwner,
        handler: () =>
          handleAckTimeoutCheck({
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

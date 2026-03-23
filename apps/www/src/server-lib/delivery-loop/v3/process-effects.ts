import { and, eq, ne, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import type { DeliveryEffectLedgerV3Row } from "@terragon/shared/db/types";
import { enqueueWorkItem } from "@terragon/shared/delivery-loop/store/work-queue-store";
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
import { parseEffectPayloadV3 } from "./contracts";
import { appendEventAndAdvanceV3 } from "./kernel";
import {
  claimNextEffectV3,
  getWorkflowHeadV3,
  markEffectFailedV3,
  markEffectSucceededV3,
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
import type { EffectResultV3, LoopEventV3 } from "./types";

const DISPATCH_WORK_ITEM_MAX_ATTEMPTS = 25;
const AWAITING_PR_CREATION_REASON = "Awaiting PR creation";

/**
 * Pure mapping from effect result to the LoopEventV3 that should be fired.
 * Returns null for results that don't require a state transition (e.g., human
 * approval pending, stale ack timeout).
 */
export function effectResultToEvent(
  result: EffectResultV3,
): LoopEventV3 | null {
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

    case "ack_timeout_check":
      if (result.outcome === "fired")
        return { type: "dispatch_ack_timeout", runId: result.runId };
      return null; // Stale timeout, version already advanced
  }
}

/**
 * Framework wrapper for state-blocking effects. Guarantees that every
 * handler execution produces exactly one event (or null for expected
 * no-transition cases). Handlers return EffectResultV3; they never
 * call appendEventAndAdvanceV3 directly.
 */
async function executeStateBlockingEffect(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  leaseOwner: string;
  handler: () => Promise<EffectResultV3>;
}): Promise<void> {
  let result: EffectResultV3;
  try {
    result = await params.handler();
  } catch (error) {
    // Handler threw — create a typed failure result based on effect kind
    const reason = error instanceof Error ? error.message : String(error);
    const kind = parseEffectPayloadV3(params.effect.payloadJson)?.kind;
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
      case "ack_timeout_check":
        result = { kind: "ack_timeout_check", outcome: "stale" };
        break;
      default:
        throw error; // Unknown effect kind, let outer catch handle
    }
  }

  // Mark effect succeeded — the effect did its work regardless of outcome
  await markEffectSucceededV3({
    db: params.db,
    effectId: params.effect.id,
    leaseOwner: params.leaseOwner,
    leaseEpoch: params.effect.leaseEpoch,
  });

  // Map result to event and fire if non-null
  const event = effectResultToEvent(result);
  if (event) {
    await appendEventAndAdvanceV3({
      db: params.db,
      workflowId: params.effect.workflowId,
      source: "system",
      idempotencyKey: `effect-result:${params.effect.id}`,
      event,
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
}): Promise<EffectResultV3> {
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

  try {
    await createDispatchIntent(intentParams);
  } catch (intentErr) {
    if (
      intentErr instanceof Error &&
      intentErr.message.includes("active intent")
    ) {
      return {
        kind: "dispatch_gate_review",
        outcome: "failed",
        reason: "Active dispatch intent already exists",
      };
    }
    throw intentErr;
  }

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

  // Queue a "Continue gate check" message for the follow-up queue
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

  // Trigger the follow-up queue to launch the sandbox run
  let dispatchLaunched = false;
  try {
    const { maybeProcessFollowUpQueue } = await import(
      "@/server-lib/process-follow-up-queue"
    );
    const followUpResult = await maybeProcessFollowUpQueue({
      userId: workflow.userId,
      threadId: workflow.threadId,
      threadChatId: threadChat.id,
    });
    dispatchLaunched = followUpResult.dispatchLaunched;
  } catch {
    // Non-fatal: cron will pick up pending follow-ups
  }

  if (dispatchLaunched) {
    return {
      kind: "dispatch_gate_review",
      outcome: "dispatched",
      runId,
      ackDeadlineAt: new Date(params.now.getTime() + DEFAULT_ACK_TIMEOUT_MS),
    };
  }

  return {
    kind: "dispatch_gate_review",
    outcome: "failed",
    reason: "Follow-up queue did not launch dispatch",
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
    await markEffectSucceededV3({
      db: params.db,
      effectId: params.effect.id,
      leaseOwner: params.leaseOwner,
      leaseEpoch: params.effect.leaseEpoch,
    });
    return;
  }

  const head = await getWorkflowHeadV3({
    db: params.db,
    workflowId: params.effect.workflowId,
  });
  const currentState = head?.state ?? workflow.kind;
  const body = formatStatusBodyV3(currentState);
  const isTerminal =
    currentState === "done" ||
    currentState === "stopped" ||
    currentState === "terminated";

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
      await markEffectSucceededV3({
        db: params.db,
        effectId: params.effect.id,
        leaseOwner: params.leaseOwner,
        leaseEpoch: params.effect.leaseEpoch,
      });
      return;
    }
    throw pubErr;
  }

  await markEffectSucceededV3({
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
}): Promise<EffectResultV3> {
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

  const head = await getWorkflowHeadV3({
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
  const thread = await params.db.query.thread.findFirst({
    where: eq(schema.thread.id, workflow.threadId),
    columns: {
      gitDiff: true,
      gitDiffStats: true,
    },
  });
  const diffStats =
    thread?.gitDiffStats &&
    typeof thread.gitDiffStats === "object" &&
    thread.gitDiffStats !== null
      ? (thread.gitDiffStats as { files?: unknown })
      : null;
  const diffFileCount =
    typeof diffStats?.files === "number" ? diffStats.files : null;
  if (diffFileCount === 0 && thread?.gitDiff !== "too-large") {
    return {
      kind: "ensure_pr",
      outcome: "no_diff",
      reason: "No code changes detected to open a PR",
    };
  }

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
}): Promise<EffectResultV3> {
  const head = await getWorkflowHeadV3({
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
}): Promise<EffectResultV3> {
  const head = await getWorkflowHeadV3({
    db: params.db,
    workflowId: params.effect.workflowId,
  });
  if (!head || head.version !== params.payload.workflowVersion) {
    return { kind: "ack_timeout_check", outcome: "stale" };
  }
  return {
    kind: "ack_timeout_check",
    outcome: "fired",
    runId: params.payload.runId,
  };
}

async function processSingleEffect(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  leaseOwner: string;
  now: Date;
}) {
  const payload = parseEffectPayloadV3(params.effect.payloadJson);
  if (!payload) {
    await markEffectFailedV3({
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
      await enqueueWorkItem({
        db: params.db,
        workflowId: params.effect.workflowId,
        correlationId: `v3:dispatch:impl:${params.effect.id}`,
        kind: "dispatch",
        payloadJson: {
          executionClass: payload.executionClass,
          workflowId: params.effect.workflowId,
        },
        maxAttempts: DISPATCH_WORK_ITEM_MAX_ATTEMPTS,
      });
      await markEffectSucceededV3({
        db: params.db,
        effectId: params.effect.id,
        leaseOwner: params.leaseOwner,
        leaseEpoch: params.effect.leaseEpoch,
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
  } catch (error) {
    await markEffectFailedV3({
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

export async function drainDueV3Effects(params: {
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
    const effect = await claimNextEffectV3({
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

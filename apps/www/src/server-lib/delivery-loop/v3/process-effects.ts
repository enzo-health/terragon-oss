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

const DISPATCH_WORK_ITEM_MAX_ATTEMPTS = 25;
const AWAITING_PR_CREATION_REASON = "Awaiting PR creation";

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
}): Promise<void> {
  const workflowId = params.effect.workflowId;

  const workflow = await getWorkflow({ db: params.db, workflowId });
  if (!workflow) {
    await markEffectSucceededV3({
      db: params.db,
      effectId: params.effect.id,
      leaseOwner: params.leaseOwner,
      leaseEpoch: params.effect.leaseEpoch,
    });
    return;
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
    await markEffectFailedV3({
      db: params.db,
      effectId: params.effect.id,
      leaseOwner: params.leaseOwner,
      leaseEpoch: params.effect.leaseEpoch,
      errorCode: "thread_chat_not_found",
      errorMessage: `No threadChat for threadId ${workflow.threadId}`,
      retryAt: addMilliseconds(params.now, 10_000),
    });
    return;
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
      // Prior attempt already created the intent — complete silently
      await markEffectSucceededV3({
        db: params.db,
        effectId: params.effect.id,
        leaseOwner: params.leaseOwner,
        leaseEpoch: params.effect.leaseEpoch,
      });
      return;
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

  // Emit dispatch_sent into v3 kernel if a run was launched
  if (dispatchLaunched) {
    await appendEventAndAdvanceV3({
      db: params.db,
      workflowId,
      source: "system",
      idempotencyKey: `dispatch-sent:${runId}`,
      event: {
        type: "dispatch_sent",
        runId,
        ackDeadlineAt: new Date(params.now.getTime() + DEFAULT_ACK_TIMEOUT_MS),
      },
    });
  }

  await markEffectSucceededV3({
    db: params.db,
    effectId: params.effect.id,
    leaseOwner: params.leaseOwner,
    leaseEpoch: params.effect.leaseEpoch,
  });
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
}): Promise<void> {
  const workflow = await getWorkflow({
    db: params.db,
    workflowId: params.effect.workflowId,
  });
  if (!workflow) {
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
  if (
    !head ||
    head.state !== "awaiting_pr" ||
    head.blockedReason !== AWAITING_PR_CREATION_REASON
  ) {
    await markEffectSucceededV3({
      db: params.db,
      effectId: params.effect.id,
      leaseOwner: params.leaseOwner,
      leaseEpoch: params.effect.leaseEpoch,
    });
    return;
  }

  if (typeof workflow.prNumber !== "number") {
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
      await appendEventAndAdvanceV3({
        db: params.db,
        workflowId: params.effect.workflowId,
        source: "system",
        idempotencyKey: `ensure-pr:${params.effect.id}:no-diff`,
        event: {
          type: "gate_review_failed",
          reason: "No code changes detected to open a PR",
        },
      });
      await markEffectSucceededV3({
        db: params.db,
        effectId: params.effect.id,
        leaseOwner: params.leaseOwner,
        leaseEpoch: params.effect.leaseEpoch,
      });
      return;
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

  await appendEventAndAdvanceV3({
    db: params.db,
    workflowId: params.effect.workflowId,
    source: "system",
    idempotencyKey: `ensure-pr:${params.effect.id}:pr-linked`,
    event: {
      type: "pr_linked",
      prNumber: refreshedWorkflow.prNumber,
    },
  });

  await markEffectSucceededV3({
    db: params.db,
    effectId: params.effect.id,
    leaseOwner: params.leaseOwner,
    leaseEpoch: params.effect.leaseEpoch,
  });
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
      await processGateReviewEffect({
        db: params.db,
        effect: params.effect,
        leaseOwner: params.leaseOwner,
        gate: payload.gate,
        now: params.now,
      });
      return;
    }

    if (payload.kind === "ensure_pr") {
      await processEnsurePrEffect({
        db: params.db,
        effect: params.effect,
        leaseOwner: params.leaseOwner,
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
      const head = await getWorkflowHeadV3({
        db: params.db,
        workflowId: params.effect.workflowId,
      });
      if (!head) {
        await markEffectSucceededV3({
          db: params.db,
          effectId: params.effect.id,
          leaseOwner: params.leaseOwner,
          leaseEpoch: params.effect.leaseEpoch,
        });
        return;
      }

      const threadChat = await params.db.query.threadChat.findFirst({
        where: eq(schema.threadChat.threadId, head.threadId),
        columns: { messages: true },
        orderBy: [desc(schema.threadChat.createdAt)],
      });

      let artifactCreated = false;
      if (threadChat?.messages) {
        const extracted = extractLatestPlanText(
          threadChat.messages as Parameters<typeof extractLatestPlanText>[0],
        );
        if (extracted) {
          const parseResult = parsePlanSpec(extracted.text);
          if (parseResult.ok) {
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
            artifactCreated = true;
          }
        }
      }

      await markEffectSucceededV3({
        db: params.db,
        effectId: params.effect.id,
        leaseOwner: params.leaseOwner,
        leaseEpoch: params.effect.leaseEpoch,
      });

      // Auto-approve plan if policy allows — fire plan_completed to
      // transition planning → implementing.  When human approval is
      // required the approve-plan UI fires plan_completed instead.
      const workflow = await getWorkflow({
        db: params.db,
        workflowId: params.effect.workflowId,
      });
      const approvalPolicy = workflow?.planApprovalPolicy ?? "auto";
      if (approvalPolicy === "auto" || !artifactCreated) {
        await appendEventAndAdvanceV3({
          db: params.db,
          workflowId: params.effect.workflowId,
          source: "system",
          idempotencyKey: `plan-auto-approve:${params.effect.workflowId}:${params.effect.id}`,
          event: { type: "plan_completed" },
        });
      }

      return;
    }

    // ack_timeout_check
    const head = await getWorkflowHeadV3({
      db: params.db,
      workflowId: params.effect.workflowId,
    });
    if (!head || head.version !== payload.workflowVersion) {
      await markEffectSucceededV3({
        db: params.db,
        effectId: params.effect.id,
        leaseOwner: params.leaseOwner,
        leaseEpoch: params.effect.leaseEpoch,
      });
      return;
    }

    await appendEventAndAdvanceV3({
      db: params.db,
      workflowId: params.effect.workflowId,
      source: "timer",
      idempotencyKey: `ack-timeout:${payload.runId}:${params.effect.id}`,
      event: {
        type: "dispatch_ack_timeout",
        runId: payload.runId,
      },
    });
    await markEffectSucceededV3({
      db: params.db,
      effectId: params.effect.id,
      leaseOwner: params.leaseOwner,
      leaseEpoch: params.effect.leaseEpoch,
    });
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

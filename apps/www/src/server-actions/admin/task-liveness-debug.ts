"use server";

import { EventType, type BaseEvent } from "@ag-ui/core";
import { adminOnly } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import * as schema from "@terragon/shared/db/schema";
import type {
  AgentRunContext,
  DeliveryWorkflowHeadV3Row,
  ThreadStatus,
} from "@terragon/shared/db/types";
import {
  agUiStreamKey,
  getLatestRunIdForThreadChat,
  hasCanonicalReplayProjection,
} from "@terragon/shared/model/agent-event-log";
import {
  getAgentRunContextByRunId,
  getLatestAgentRunContextForThreadChat,
} from "@terragon/shared/model/agent-run-context";
import {
  getThreadPageChatWithPermissions,
  getThreadPageShellWithPermissions,
} from "@terragon/shared/model/thread-page";
import { and, desc, eq } from "drizzle-orm";
import * as z from "zod/v4";
import {
  buildSnapshotFromHead,
  classifyLivenessEvidence,
  getDeliveryLoopAwareThreadStatus,
  shouldUseDeliveryLoopHeadOverride,
} from "@/lib/delivery-loop-status";
import type { WorkflowHead } from "@/server-lib/delivery-loop/v3/types";
import { isAgentWorking as isThreadStatusWorking } from "@/agent/thread-status";

type ParsedStreamEvent = BaseEvent & { runId?: string };

const SAFE_THREAD_ERROR_CATEGORIES = [
  "request-timeout",
  "no-user-message",
  "unknown-error",
  "sandbox-not-found",
  "sandbox-creation-failed",
  "sandbox-resume-failed",
  "missing-gemini-credentials",
  "missing-amp-credentials",
  "chatgpt-sub-required",
  "invalid-codex-credentials",
  "invalid-claude-credentials",
  "agent-not-responding",
  "agent-generic-error",
  "git-checkpoint-diff-failed",
  "git-checkpoint-push-failed",
  "setup-script-failed",
  "prompt-too-long",
  "queue-limit-exceeded",
] as const;

const safeThreadErrorCategorySet = new Set<string>(
  SAFE_THREAD_ERROR_CATEGORIES,
);

function parseRedisStreamTail(
  raw: unknown,
): Array<{ id: string; event: BaseEvent }> {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const entries: Array<{ id: string; event: BaseEvent }> = [];
  for (const id of Object.keys(raw)) {
    const fields = Reflect.get(raw, id) as unknown;
    const eventField = readStreamEventField(fields);
    if (!eventField) {
      continue;
    }
    try {
      const parsed = JSON.parse(eventField) as BaseEvent;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.type === "string"
      ) {
        entries.push({ id, event: parsed });
      }
    } catch {
      continue;
    }
  }
  return entries;
}

function readStreamEventField(rawFields: unknown): string | null {
  if (!rawFields || typeof rawFields !== "object") {
    return null;
  }

  // Upstash can return an object like: { event: "..." }
  const direct = Reflect.get(rawFields, "event");
  if (typeof direct === "string") {
    return direct;
  }

  // Some callers might serialize as an array [field, value, ...]
  if (Array.isArray(rawFields)) {
    for (let i = 0; i < rawFields.length; i += 2) {
      if (rawFields[i] === "event" && typeof rawFields[i + 1] === "string") {
        return rawFields[i + 1] as string;
      }
    }
  }

  return null;
}

function parseRedisStreamEntryMs(id: string): number | null {
  const dash = id.indexOf("-");
  const rawMs = dash === -1 ? id : id.slice(0, dash);
  if (!rawMs) {
    return null;
  }
  const ms = Number(rawMs);
  return Number.isFinite(ms) ? ms : null;
}

function isTerminalRunEventType(type: BaseEvent["type"]): boolean {
  return type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR;
}

function toSafeThreadErrorCategory(
  rawErrorMessage: string | null | undefined,
): (typeof SAFE_THREAD_ERROR_CATEGORIES)[number] | "other" | null {
  if (typeof rawErrorMessage !== "string" || rawErrorMessage.length === 0) {
    return null;
  }
  return safeThreadErrorCategorySet.has(rawErrorMessage)
    ? (rawErrorMessage as (typeof SAFE_THREAD_ERROR_CATEGORIES)[number])
    : "other";
}

function normalizeWorkflowHeadState(
  state: DeliveryWorkflowHeadV3Row["state"],
): WorkflowHead["state"] {
  switch (state) {
    case "planning":
      return "planning";
    case "awaiting_implementation_acceptance":
      return "implementing";
    case "implementing":
    case "gating_review":
    case "gating_ci":
    case "awaiting_pr_creation":
    case "awaiting_pr_lifecycle":
    case "awaiting_manual_fix":
    case "awaiting_operator_action":
    case "done":
    case "stopped":
    case "terminated":
      return state;
    default:
      return "implementing";
  }
}

function toWorkflowHead(row: DeliveryWorkflowHeadV3Row): WorkflowHead {
  return {
    workflowId: row.workflowId,
    threadId: row.threadId,
    generation: row.generation,
    version: row.version,
    state: normalizeWorkflowHeadState(row.state),
    activeGate: row.activeGate,
    headSha: row.headSha,
    activeRunId: row.activeRunId,
    activeRunSeq: row.activeRunSeq,
    leaseExpiresAt: row.leaseExpiresAt,
    lastTerminalRunSeq: row.lastTerminalRunSeq,
    fixAttemptCount: row.fixAttemptCount,
    infraRetryCount: row.infraRetryCount,
    maxFixAttempts: row.maxFixAttempts,
    maxInfraRetries: row.maxInfraRetries,
    narrationOnlyRetryCount: row.narrationOnlyRetryCount,
    lastResurrectedAt: row.lastResurrectedAt,
    blockedReason: row.blockedReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
  };
}

const taskLivenessDebugPayloadSchema = z.object({
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
  nowIso: z.string().datetime(),
  summary: z.string().min(1),
  ui: z.object({
    threadChatStatus: z.string().nullable(),
    deliveryLoopState: z.string().nullable(),
    effectiveThreadStatus: z.string().nullable(),
    isWorking: z.boolean(),
    canApplyDeliveryLoopHeadOverride: z.boolean(),
    livenessEvidence: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("fresh"),
        latestEvidenceAtIso: z.string().datetime(),
        ageMs: z.number().int(),
      }),
      z.object({
        kind: z.literal("stale"),
        latestEvidenceAtIso: z.string().datetime(),
        ageMs: z.number().int(),
      }),
      z.object({ kind: z.literal("unknown") }),
    ]),
  }),
  surfaces: z.object({
    threadChat: z.object({
      updatedAtIso: z.string().datetime(),
      messageSeq: z.number().int().nullable(),
      scheduleAtIso: z.string().datetime().nullable(),
      reattemptQueueAtIso: z.string().datetime().nullable(),
      errorCategory: z
        .enum([...SAFE_THREAD_ERROR_CATEGORIES, "other"])
        .nullable(),
    }),
    workflowHeadV3: z
      .object({
        workflowId: z.string().min(1),
        state: z.string().min(1),
        updatedAtIso: z.string().datetime(),
        lastActivityAtIso: z.string().datetime().nullable(),
        activeRunId: z.string().nullable(),
        activeRunSeq: z.number().int().nullable(),
        leaseExpiresAtIso: z.string().datetime().nullable(),
        lastTerminalRunSeq: z.number().int().nullable(),
      })
      .nullable(),
    agentRunContext: z.object({
      latestForThreadChat: z
        .object({
          runId: z.string().min(1),
          status: z.string().min(1),
          workflowId: z.string().nullable(),
          runSeq: z.number().int().nullable(),
          updatedAtIso: z.string().datetime(),
        })
        .nullable(),
      forActiveRunId: z
        .object({
          runId: z.string().min(1),
          status: z.string().min(1),
          workflowId: z.string().nullable(),
          runSeq: z.number().int().nullable(),
          updatedAtIso: z.string().datetime(),
        })
        .nullable(),
    }),
    agentEventLog: z.object({
      hasCanonicalReplayProjection: z.boolean(),
      latestWellFormedRunId: z.string().nullable(),
      latestRow: z
        .object({
          runId: z.string().min(1),
          seq: z.number().int(),
          eventType: z.string().min(1),
          timestampIso: z.string().datetime(),
          threadChatMessageSeq: z.number().int().nullable(),
        })
        .nullable(),
    }),
    redisAgUiStream: z.object({
      streamKey: z.string().min(1),
      availability: z.enum(["available", "unavailable"]),
      unavailableReason: z.literal("xrevrange_failed").nullable(),
      sampledTailSize: z.number().int(),
      latestEntryId: z.string().nullable(),
      latestEntryAtIso: z.string().datetime().nullable(),
      targetRunId: z.string().nullable(),
      hasTerminalMarkerForTargetRun: z.boolean().nullable(),
      latestTerminalMarker: z
        .object({
          type: z.string().min(1),
          runId: z.string().min(1),
          redisId: z.string().min(1),
          redisAtIso: z.string().datetime().nullable(),
        })
        .nullable(),
    }),
  }),
});

export type TaskLivenessDebugPayload = z.infer<
  typeof taskLivenessDebugPayloadSchema
>;

function toRunContextSurface(
  ctx: AgentRunContext | null,
): TaskLivenessDebugPayload["surfaces"]["agentRunContext"]["latestForThreadChat"] {
  if (!ctx) {
    return null;
  }
  return {
    runId: ctx.runId,
    status: ctx.status,
    workflowId: ctx.workflowId ?? null,
    runSeq: ctx.runSeq ?? null,
    updatedAtIso: ctx.updatedAt.toISOString(),
  };
}

function toWorkflowHeadSurface(
  head: DeliveryWorkflowHeadV3Row | null,
): TaskLivenessDebugPayload["surfaces"]["workflowHeadV3"] {
  if (!head) {
    return null;
  }
  return {
    workflowId: head.workflowId,
    state: head.state,
    updatedAtIso: head.updatedAt.toISOString(),
    lastActivityAtIso: head.lastActivityAt?.toISOString() ?? null,
    activeRunId: head.activeRunId ?? null,
    activeRunSeq: head.activeRunSeq ?? null,
    leaseExpiresAtIso: head.leaseExpiresAt?.toISOString() ?? null,
    lastTerminalRunSeq: head.lastTerminalRunSeq ?? null,
  };
}

function formatEvidence(
  evidence: ReturnType<typeof classifyLivenessEvidence>,
): TaskLivenessDebugPayload["ui"]["livenessEvidence"] {
  switch (evidence.kind) {
    case "unknown":
      return { kind: "unknown" };
    case "fresh":
    case "stale":
      return {
        kind: evidence.kind,
        latestEvidenceAtIso: evidence.latestEvidenceAt.toISOString(),
        ageMs: Math.trunc(evidence.ageMs),
      };
  }
}

export const getTaskLivenessDebugPayload = adminOnly(
  async function getTaskLivenessDebugPayload(
    adminUser,
    params: { threadId: string; threadChatId?: string | null },
  ): Promise<TaskLivenessDebugPayload> {
    const now = new Date();

    const threadChatIdInput =
      params.threadChatId && params.threadChatId.length > 0
        ? params.threadChatId
        : null;

    const effectiveThreadChatId =
      threadChatIdInput ??
      (
        await getThreadPageShellWithPermissions({
          db,
          threadId: params.threadId,
          userId: adminUser.id,
          allowAdmin: true,
        })
      )?.primaryThreadChatId ??
      null;

    if (!effectiveThreadChatId) {
      throw new Error("Thread not found");
    }

    // We intentionally use the shared permission helper so the payload matches
    // the same "thread chat the UI sees" semantics (primary chat, admin bypass).
    const threadChat = await getThreadPageChatWithPermissions({
      db,
      threadId: params.threadId,
      threadChatId: effectiveThreadChatId,
      userId: adminUser.id,
      allowAdmin: true,
    });

    if (!threadChat) {
      throw new Error("Thread chat not found");
    }

    const threadId = threadChat.threadId;
    const threadChatId = threadChat.id;
    const ownerUserId = threadChat.userId;

    const headRow = await db.query.deliveryWorkflowHeadV3.findFirst({
      where: eq(schema.deliveryWorkflowHeadV3.threadId, threadId),
      orderBy: [
        desc(schema.deliveryWorkflowHeadV3.generation),
        desc(schema.deliveryWorkflowHeadV3.version),
      ],
    });

    const head = headRow ? toWorkflowHead(headRow) : null;
    const snapshot = head ? buildSnapshotFromHead(head) : null;
    const deliveryLoopState = snapshot ? snapshot.kind : null;
    const deliveryLoopUpdatedAtIso = headRow?.updatedAt.toISOString() ?? null;

    const canApplyDeliveryLoopHeadOverride = shouldUseDeliveryLoopHeadOverride({
      now,
      deliveryLoopUpdatedAtIso,
      threadChatUpdatedAt: threadChat.updatedAt,
    });

    const effectiveThreadStatus = getDeliveryLoopAwareThreadStatus({
      threadStatus: (threadChat.status ?? null) as ThreadStatus | null,
      deliveryLoopState,
      deliveryLoopUpdatedAtIso,
      threadChatUpdatedAt: threadChat.updatedAt,
      now,
    });

    const evidence = classifyLivenessEvidence({
      now,
      threadChatUpdatedAt: threadChat.updatedAt,
      deliveryLoopUpdatedAtIso,
    });

    const latestRunContext = await getLatestAgentRunContextForThreadChat({
      db,
      userId: ownerUserId,
      threadId,
      threadChatId,
    });

    const activeRunId = headRow?.activeRunId ?? null;
    const activeRunContext =
      activeRunId === null
        ? null
        : await getAgentRunContextByRunId({
            db,
            runId: activeRunId,
            userId: ownerUserId,
          });

    const replayRunId = await getLatestRunIdForThreadChat({
      db,
      threadChatId,
    });

    const hasReplayProjection = await hasCanonicalReplayProjection({
      db,
      threadId,
      threadChatId,
    });

    const latestLogRow = await db.query.agentEventLog.findFirst({
      where: and(
        eq(schema.agentEventLog.threadId, threadId),
        eq(schema.agentEventLog.threadChatId, threadChatId),
      ),
      orderBy: [desc(schema.agentEventLog.logSeq)],
      columns: {
        runId: true,
        seq: true,
        eventType: true,
        timestamp: true,
        threadChatMessageSeq: true,
      },
    });

    const streamKey = agUiStreamKey(threadChatId);
    let redisUnavailableReason: "xrevrange_failed" | null = null;
    let tail: Array<{ id: string; event: BaseEvent }> = [];
    try {
      const rawTail = await redis.xrevrange(streamKey, "+", "-", 32);
      tail = parseRedisStreamTail(rawTail);
    } catch (error) {
      redisUnavailableReason = "xrevrange_failed";
      console.warn("[task-liveness-debug] redis stream tail unavailable", {
        threadId,
        threadChatId,
        error,
      });
    }

    const sortedTail = tail
      .map((entry) => ({
        ...entry,
        entryMs: parseRedisStreamEntryMs(entry.id),
      }))
      .sort((a, b) => (b.entryMs ?? 0) - (a.entryMs ?? 0));

    const latestStreamEntry = sortedTail[0] ?? null;
    const latestEntryAtIso =
      latestStreamEntry?.entryMs != null
        ? new Date(latestStreamEntry.entryMs).toISOString()
        : null;

    const terminalCandidates = sortedTail.filter((entry) =>
      isTerminalRunEventType(entry.event.type),
    );

    const inferredTargetRunId =
      activeRunId ?? latestRunContext?.runId ?? replayRunId ?? null;

    const latestTerminalMarker = terminalCandidates
      .map((entry) => ({
        entry,
        runId: (entry.event as ParsedStreamEvent).runId ?? null,
      }))
      .find((candidate) => candidate.runId !== null);

    const terminalForTarget =
      inferredTargetRunId === null
        ? null
        : terminalCandidates.some(
            (entry) =>
              (entry.event as ParsedStreamEvent).runId === inferredTargetRunId,
          );

    const summaryParts: string[] = [];
    summaryParts.push(
      `threadChat.status=${threadChat.status ?? "null"}`,
      `deliveryLoopState=${deliveryLoopState ?? "null"}`,
      `effectiveThreadStatus=${effectiveThreadStatus ?? "null"}`,
    );
    if (
      effectiveThreadStatus !== null &&
      effectiveThreadStatus !== threadChat.status
    ) {
      summaryParts.push(
        canApplyDeliveryLoopHeadOverride
          ? "override=deliveryLoopHead"
          : "override=blocked_by_freshness",
      );
    }
    if (inferredTargetRunId) {
      summaryParts.push(`targetRunId=${inferredTargetRunId}`);
    }
    if (terminalForTarget !== null) {
      summaryParts.push(
        terminalForTarget
          ? "redisTerminalMarker=present"
          : "redisTerminalMarker=missing",
      );
    }
    if (redisUnavailableReason !== null) {
      summaryParts.push("redisSurface=unavailable");
    }

    const payload: TaskLivenessDebugPayload = {
      threadId,
      threadChatId,
      nowIso: now.toISOString(),
      summary: summaryParts.join(" "),
      ui: {
        threadChatStatus: threadChat.status ?? null,
        deliveryLoopState,
        effectiveThreadStatus,
        isWorking:
          effectiveThreadStatus !== null &&
          isThreadStatusWorking(effectiveThreadStatus),
        canApplyDeliveryLoopHeadOverride,
        livenessEvidence: formatEvidence(evidence),
      },
      surfaces: {
        threadChat: {
          updatedAtIso: threadChat.updatedAt.toISOString(),
          messageSeq: threadChat.messageSeq ?? null,
          scheduleAtIso: threadChat.scheduleAt?.toISOString() ?? null,
          reattemptQueueAtIso:
            threadChat.reattemptQueueAt?.toISOString() ?? null,
          errorCategory: toSafeThreadErrorCategory(threadChat.errorMessage),
        },
        workflowHeadV3: toWorkflowHeadSurface(headRow ?? null),
        agentRunContext: {
          latestForThreadChat: toRunContextSurface(latestRunContext),
          forActiveRunId: toRunContextSurface(activeRunContext),
        },
        agentEventLog: {
          hasCanonicalReplayProjection: hasReplayProjection,
          latestWellFormedRunId: replayRunId,
          latestRow: latestLogRow
            ? {
                runId: latestLogRow.runId,
                seq: latestLogRow.seq,
                eventType: latestLogRow.eventType,
                timestampIso: latestLogRow.timestamp.toISOString(),
                threadChatMessageSeq: latestLogRow.threadChatMessageSeq ?? null,
              }
            : null,
        },
        redisAgUiStream: {
          streamKey,
          availability:
            redisUnavailableReason === null ? "available" : "unavailable",
          unavailableReason: redisUnavailableReason,
          sampledTailSize: sortedTail.length,
          latestEntryId: latestStreamEntry?.id ?? null,
          latestEntryAtIso,
          targetRunId: inferredTargetRunId,
          hasTerminalMarkerForTargetRun: terminalForTarget,
          latestTerminalMarker: latestTerminalMarker
            ? {
                type: latestTerminalMarker.entry.event.type,
                runId: latestTerminalMarker.runId!,
                redisId: latestTerminalMarker.entry.id,
                redisAtIso:
                  latestTerminalMarker.entry.entryMs != null
                    ? new Date(latestTerminalMarker.entry.entryMs).toISOString()
                    : null,
              }
            : null,
        },
      },
    };

    const parsed = taskLivenessDebugPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[task-liveness-debug] invalid payload", parsed.error);
      throw new Error("Invalid task liveness debug payload");
    }

    return parsed.data;
  },
);

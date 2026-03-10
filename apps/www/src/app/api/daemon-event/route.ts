import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import {
  DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
  DAEMON_CAPABILITY_SDLC_SELF_DISPATCH,
  DAEMON_EVENT_CAPABILITIES_HEADER,
  DAEMON_EVENT_VERSION_HEADER,
  DaemonEventAPIBody,
  type SdlcSelfDispatchPayload,
} from "@terragon/daemon/shared";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import {
  getActiveSdlcLoopForThread,
  SDLC_CAUSE_IDENTITY_VERSION,
  markDispatchIntentDispatched,
  markDispatchIntentCompleted,
  markDispatchIntentFailed,
  type DeliveryLoopFailureCategory,
  type DeliveryLoopSelectedAgent,
} from "@terragon/shared/model/delivery-loop";
import {
  buildDispatchIntentId,
  createDispatchIntent,
  getReplayableSelfDispatch,
  storeSelfDispatchReplay,
  updateDispatchIntent,
} from "@/server-lib/delivery-loop/dispatch-intent";
import {
  handleAckReceived,
  startAckTimeout,
} from "@/server-lib/delivery-loop/ack-lifecycle";
import {
  getAgentRunContextByRunId,
  upsertAgentRunContext,
  updateAgentRunContext,
} from "@terragon/shared/model/agent-run-context";
import { and, eq, isNull, sql } from "drizzle-orm";
import { runBestEffortSdlcPublicationCoordinator } from "@/server-lib/delivery-loop/publication";
import { runBestEffortSdlcSignalInboxTick } from "@/server-lib/delivery-loop/signal-inbox";
import { maybeProcessFollowUpQueue } from "@/server-lib/process-follow-up-queue";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { waitUntil } from "@vercel/functions";
import { redis } from "@/lib/redis";
import { createDaemonRunCredentials } from "@/agent/helpers/create-daemon-run";
import { getFeatureFlagsForUser } from "@terragon/shared/model/feature-flags";
import {
  getThreadChat,
  getThreadMinimal,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import {
  normalizedModelForDaemon,
  getDefaultModelForAgent,
  shouldUseCredits,
} from "@terragon/agent/utils";
import { getUserCredentials } from "@/server-lib/user-credentials";
import { randomUUID } from "node:crypto";

type DaemonEventEnvelopeV2 = {
  payloadVersion: 2;
  eventId: string;
  runId: string;
  seq: number;
};

type DaemonEventClaimResult =
  | {
      claimed: true;
      signalInboxId: string;
    }
  | {
      claimed: false;
      reason:
        | "claim_in_progress"
        | "duplicate_event"
        | "out_of_order_or_duplicate_seq";
    };

type DaemonEventCommitResult =
  | {
      committed: true;
      state: "committed_now" | "already_committed_or_processed";
    }
  | {
      committed: false;
      state: "claim_lost";
    };

const DAEMON_EVENT_CLAIM_STALE_MS = 5 * 60 * 1000;
const SDLC_DAEMON_RECOVERY_TTL_SECONDS = 30 * 60;
const DAEMON_PROCESSING_EVENT_CLAIM_TTL_SECONDS = 60;
const DAEMON_PROCESSING_EVENT_COMMITTED_TTL_SECONDS = 60 * 60 * 24;

/**
 * Circuit breaker: maximum number of consecutive auto-dispatched follow-up
 * runs (daemon_terminal with daemonRunStatus=completed) before we stop
 * auto-dispatching to prevent infinite loops.
 */
const MAX_CONSECUTIVE_AUTO_DISPATCHES = 10;

type DaemonTerminalErrorCategory =
  | "provider_not_configured"
  | "acp_sse_not_found"
  | "daemon_custom_error"
  | "daemon_result_error"
  | "unknown";

function mapDaemonTerminalCategoryToFailureCategory(
  category: DaemonTerminalErrorCategory,
): DeliveryLoopFailureCategory {
  switch (category) {
    case "provider_not_configured":
      return "config_error";
    case "acp_sse_not_found":
      return "daemon_unreachable";
    case "daemon_custom_error":
    case "daemon_result_error":
      return "claude_runtime_exit";
    case "unknown":
      return "unknown";
  }
  return "unknown";
}

type DaemonProcessingEventClaimResult =
  | {
      claimed: true;
    }
  | {
      claimed: false;
      reason: "claim_in_progress" | "duplicate_event";
    };

type TerminalAckBase = {
  status?: number;
  deduplicated?: true;
  reason?: string;
  loopId?: string;
  runId?: string;
  acknowledgedEventId: string | null;
  acknowledgedSeq: number | null;
};

type TerminalAckState =
  | (TerminalAckBase & { kind: "ack_only" })
  | (TerminalAckBase & {
      kind: "self_dispatch";
      selfDispatch: SdlcSelfDispatchPayload;
    });

function buildTerminalAckState(
  base: TerminalAckBase,
  selfDispatch: SdlcSelfDispatchPayload | null,
): TerminalAckState {
  return selfDispatch
    ? { ...base, kind: "self_dispatch", selfDispatch }
    : { ...base, kind: "ack_only" };
}

function jsonTerminalAckResponse(state: TerminalAckState): Response {
  return Response.json(
    {
      success: true,
      ...(state.deduplicated ? { deduplicated: true } : {}),
      ...(state.reason ? { reason: state.reason } : {}),
      ...(state.loopId ? { loopId: state.loopId } : {}),
      ...(state.runId ? { runId: state.runId } : {}),
      acknowledgedEventId: state.acknowledgedEventId,
      acknowledgedSeq: state.acknowledgedSeq,
      ...(state.kind === "self_dispatch"
        ? { selfDispatch: state.selfDispatch }
        : {}),
    },
    { status: state.status ?? 200 },
  );
}

/**
 * Count trailing consecutive daemon_terminal signals with
 * daemonRunStatus=completed for this loop. Any non-completed signal
 * (failed, stopped, or non-daemon_terminal cause) resets the streak,
 * so user-initiated actions or failures unblock the breaker.
 */
async function countConsecutiveCompletedAutoDispatches({
  loopId,
}: {
  loopId: string;
}): Promise<number> {
  // Single query: count completed daemon_terminal signals that appear after
  // the most recent non-completed one (i.e. trailing consecutive completed).
  const result = await db.execute(sql`
    SELECT count(*) AS count
    FROM ${schema.sdlcLoopSignalInbox}
    WHERE ${schema.sdlcLoopSignalInbox.loopId} = ${loopId}
      AND ${schema.sdlcLoopSignalInbox.causeType} = 'daemon_terminal'
      AND ${schema.sdlcLoopSignalInbox.processedAt} IS NOT NULL
      AND ${schema.sdlcLoopSignalInbox.payload}->>'daemonRunStatus' = 'completed'
      AND ${schema.sdlcLoopSignalInbox.processedAt} > COALESCE(
        (SELECT ${schema.sdlcLoopSignalInbox.processedAt}
         FROM ${schema.sdlcLoopSignalInbox}
         WHERE ${schema.sdlcLoopSignalInbox.loopId} = ${loopId}
           AND ${schema.sdlcLoopSignalInbox.causeType} = 'daemon_terminal'
           AND ${schema.sdlcLoopSignalInbox.processedAt} IS NOT NULL
           AND ${schema.sdlcLoopSignalInbox.payload}->>'daemonRunStatus' != 'completed'
         ORDER BY ${schema.sdlcLoopSignalInbox.processedAt} DESC
         LIMIT 1),
        '1970-01-01'::timestamp
      )
  `);
  const rows = result as unknown as Array<{ count: string | number }>;
  return Number(rows[0]?.count ?? 0);
}

function getDaemonProcessingEventClaimKey({
  loopId,
  eventId,
}: {
  loopId: string;
  eventId: string;
}): string {
  return `sdlc:daemon-processing-event:claim:${loopId}:${eventId}`;
}

function getDaemonProcessingEventCommittedKey({
  loopId,
  eventId,
}: {
  loopId: string;
  eventId: string;
}): string {
  return `sdlc:daemon-processing-event:committed:${loopId}:${eventId}`;
}

async function persistDaemonTerminalDispatchStatus(params: {
  loopId: string;
  threadChatId: string;
  runId: string;
  daemonRunStatus: "completed" | "failed" | "stopped";
  daemonErrorMessage: string | null;
  daemonErrorCategory: DaemonTerminalErrorCategory;
}): Promise<void> {
  const intentId = buildDispatchIntentId(params.loopId, params.runId);
  if (params.daemonRunStatus === "completed") {
    await Promise.all([
      updateDispatchIntent(intentId, params.threadChatId, {
        status: "completed",
        lastError: null,
        lastFailureCategory: null,
      }),
      markDispatchIntentCompleted(db, params.runId),
    ]);
    return;
  }

  const failureMessage =
    params.daemonErrorMessage ??
    `daemon terminal status: ${params.daemonRunStatus}`;
  const failureCategory = mapDaemonTerminalCategoryToFailureCategory(
    params.daemonErrorCategory,
  );

  await Promise.all([
    updateDispatchIntent(intentId, params.threadChatId, {
      status: "failed",
      lastError: failureMessage,
      lastFailureCategory: failureCategory,
    }),
    markDispatchIntentFailed(db, params.runId, failureCategory, failureMessage),
  ]);
}

async function claimEnrolledLoopProcessingEvent({
  loopId,
  envelope,
}: {
  loopId: string;
  envelope: DaemonEventEnvelopeV2;
}): Promise<DaemonProcessingEventClaimResult> {
  const claimKey = getDaemonProcessingEventClaimKey({
    loopId,
    eventId: envelope.eventId,
  });
  const committedKey = getDaemonProcessingEventCommittedKey({
    loopId,
    eventId: envelope.eventId,
  });

  const alreadyCommitted = await redis.get<string>(committedKey);
  if (alreadyCommitted) {
    return {
      claimed: false,
      reason: "duplicate_event",
    };
  }

  const claimed = await redis.set(claimKey, new Date().toISOString(), {
    nx: true,
    ex: DAEMON_PROCESSING_EVENT_CLAIM_TTL_SECONDS,
  });
  if (claimed === "OK") {
    return {
      claimed: true,
    };
  }

  const committedAfterClaimFailure = await redis.get<string>(committedKey);
  return {
    claimed: false,
    reason: committedAfterClaimFailure
      ? "duplicate_event"
      : "claim_in_progress",
  };
}

async function commitEnrolledLoopProcessingEvent({
  loopId,
  envelope,
}: {
  loopId: string;
  envelope: DaemonEventEnvelopeV2;
}): Promise<void> {
  const claimKey = getDaemonProcessingEventClaimKey({
    loopId,
    eventId: envelope.eventId,
  });
  const committedKey = getDaemonProcessingEventCommittedKey({
    loopId,
    eventId: envelope.eventId,
  });
  const pipeline = redis.pipeline();
  pipeline.set(committedKey, new Date().toISOString(), {
    ex: DAEMON_PROCESSING_EVENT_COMMITTED_TTL_SECONDS,
  });
  pipeline.del(claimKey);
  await pipeline.exec();
}

async function rollbackEnrolledLoopProcessingEventClaim({
  loopId,
  envelope,
}: {
  loopId: string;
  envelope: DaemonEventEnvelopeV2;
}): Promise<void> {
  const claimKey = getDaemonProcessingEventClaimKey({
    loopId,
    eventId: envelope.eventId,
  });
  await redis.del(claimKey);
}

function buildCoordinatorGuardrailRuntime(loopVersion: unknown) {
  const iterationCount =
    typeof loopVersion === "number" && Number.isFinite(loopVersion)
      ? Math.max(loopVersion, 0)
      : 0;
  return {
    killSwitchEnabled: false,
    cooldownUntil: null,
    maxIterations: 15,
    manualIntentAllowed: true,
    iterationCount,
  };
}

function getDaemonEventEnvelopeV2(
  body: DaemonEventAPIBody,
): DaemonEventEnvelopeV2 | null {
  if (body.payloadVersion !== 2) {
    return null;
  }
  if (typeof body.eventId !== "string" || body.eventId.length === 0) {
    return null;
  }
  if (typeof body.runId !== "string" || body.runId.length === 0) {
    return null;
  }
  const seq = body.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    return null;
  }
  return {
    payloadVersion: 2,
    eventId: body.eventId,
    runId: body.runId,
    seq,
  };
}

function deriveSessionIdFromMessages(
  messages: DaemonEventAPIBody["messages"],
): string | null {
  for (const message of messages) {
    if (message.type === "assistant" || message.type === "user") {
      if (typeof message.session_id === "string" && message.session_id.length) {
        return message.session_id;
      }
    }
  }
  return null;
}

function deriveRunStatusFromMessages(
  messages: DaemonEventAPIBody["messages"],
): "processing" | "completed" | "failed" | "stopped" {
  let sawResult = false;
  for (const message of messages) {
    if (message.type === "custom-stop") {
      return "stopped";
    }
    if (message.type === "custom-error") {
      return "failed";
    }
    if (message.type === "result") {
      sawResult = true;
      if (message.is_error) {
        return "failed";
      }
    }
  }
  if (sawResult) {
    return "completed";
  }
  return "processing";
}

function classifyDaemonTerminalErrorCategory(
  errorMessage: string | null,
): DaemonTerminalErrorCategory {
  if (!errorMessage) {
    return "unknown";
  }
  if (errorMessage.includes("provider not configured")) {
    return "provider_not_configured";
  }
  if (errorMessage.includes("SSE failed (404")) {
    return "acp_sse_not_found";
  }
  return "daemon_custom_error";
}

function deriveDaemonTerminalErrorInfo(
  messages: DaemonEventAPIBody["messages"],
): { errorMessage: string | null; errorCategory: DaemonTerminalErrorCategory } {
  for (const message of messages) {
    if (message.type === "custom-error") {
      const errorMessage = message.error_info ?? null;
      return {
        errorMessage,
        errorCategory: classifyDaemonTerminalErrorCategory(errorMessage),
      };
    }
    if (message.type === "result" && message.is_error) {
      const errorMessage =
        "error" in message && typeof message.error === "string"
          ? message.error
          : null;
      return {
        errorMessage,
        errorCategory: "daemon_result_error",
      };
    }
  }
  return {
    errorMessage: null,
    errorCategory: "unknown",
  };
}

function getDeliveryLoopDaemonRecoveryKey({
  loopId,
  loopVersion,
}: {
  loopId: string;
  loopVersion: number;
}) {
  return `sdlc-daemon-follow-up-recovery:${loopId}:${loopVersion}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDaemonCapabilitiesHeader(
  daemonCapabilitiesHeader: string | null,
): Set<string> {
  if (!daemonCapabilitiesHeader) {
    return new Set();
  }
  return new Set(
    daemonCapabilitiesHeader
      .split(",")
      .map((capability) => capability.trim())
      .filter((capability) => capability.length > 0),
  );
}

function hasNonLegacyDaemonPayload(body: DaemonEventAPIBody): boolean {
  return (
    body.payloadVersion !== undefined ||
    body.eventId !== undefined ||
    body.runId !== undefined ||
    body.seq !== undefined
  );
}

function hasRequiredThreadChatIdForNonLegacyPayload(
  threadChatId: unknown,
): threadChatId is string {
  return (
    typeof threadChatId === "string" &&
    threadChatId.length > 0 &&
    threadChatId !== LEGACY_THREAD_CHAT_ID
  );
}

async function claimEnrolledLoopDaemonEvent({
  loopId,
  threadId,
  threadChatId,
  envelope,
  daemonRunStatus,
  daemonErrorMessage,
  daemonErrorCategory,
}: {
  loopId: string;
  threadId: string;
  threadChatId: string;
  envelope: DaemonEventEnvelopeV2;
  daemonRunStatus: "processing" | "completed" | "failed" | "stopped";
  daemonErrorMessage: string | null;
  daemonErrorCategory: DaemonTerminalErrorCategory;
}): Promise<DaemonEventClaimResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${loopId}), hashtext(${envelope.runId}))`,
    );

    const existingSignal = await tx
      .select({
        id: schema.sdlcLoopSignalInbox.id,
        receivedAt: schema.sdlcLoopSignalInbox.receivedAt,
        committedAt: schema.sdlcLoopSignalInbox.committedAt,
        processedAt: schema.sdlcLoopSignalInbox.processedAt,
      })
      .from(schema.sdlcLoopSignalInbox)
      .where(
        and(
          eq(schema.sdlcLoopSignalInbox.loopId, loopId),
          eq(schema.sdlcLoopSignalInbox.causeType, "daemon_terminal"),
          eq(schema.sdlcLoopSignalInbox.canonicalCauseId, envelope.eventId),
          eq(
            schema.sdlcLoopSignalInbox.causeIdentityVersion,
            SDLC_CAUSE_IDENTITY_VERSION,
          ),
        ),
      );

    if (existingSignal.length > 0) {
      const existing = existingSignal[0]!;
      if (existing.processedAt || existing.committedAt) {
        return {
          claimed: false,
          reason: "duplicate_event",
        };
      }

      const claimAgeMs = Math.max(
        0,
        Date.now() - existing.receivedAt.getTime(),
      );
      if (claimAgeMs < DAEMON_EVENT_CLAIM_STALE_MS) {
        return {
          claimed: false,
          reason: "claim_in_progress",
        };
      }

      // Recovery path: stale unprocessed claims are reclaimed so the daemon
      // event can be safely replayed and committed by the current worker.
      const staleReclaim = await tx
        .delete(schema.sdlcLoopSignalInbox)
        .where(
          and(
            eq(schema.sdlcLoopSignalInbox.id, existing.id),
            eq(schema.sdlcLoopSignalInbox.loopId, loopId),
            eq(schema.sdlcLoopSignalInbox.causeType, "daemon_terminal"),
            eq(schema.sdlcLoopSignalInbox.canonicalCauseId, envelope.eventId),
            eq(
              schema.sdlcLoopSignalInbox.causeIdentityVersion,
              SDLC_CAUSE_IDENTITY_VERSION,
            ),
            isNull(schema.sdlcLoopSignalInbox.committedAt),
            isNull(schema.sdlcLoopSignalInbox.processedAt),
          ),
        )
        .returning({ id: schema.sdlcLoopSignalInbox.id });
      if (staleReclaim.length > 0) {
        console.warn(
          "[sdlc-loop] reclaimed stale daemon signal claim for replay",
          {
            loopId,
            threadId,
            eventId: envelope.eventId,
            seq: envelope.seq,
            claimAgeMs,
          },
        );
      } else {
        return {
          claimed: false,
          reason: "claim_in_progress",
        };
      }
    }

    const [sequenceState] = await tx
      .select({
        maxSeq: sql<
          number | null
        >`max(((${schema.sdlcLoopSignalInbox.payload} ->> 'seq')::bigint))`,
      })
      .from(schema.sdlcLoopSignalInbox)
      .where(
        and(
          eq(schema.sdlcLoopSignalInbox.loopId, loopId),
          eq(schema.sdlcLoopSignalInbox.causeType, "daemon_terminal"),
          sql`${schema.sdlcLoopSignalInbox.payload} ->> 'runId' = ${envelope.runId}`,
        ),
      );

    const maxSeq =
      sequenceState?.maxSeq == null ? null : Number(sequenceState.maxSeq);
    if (maxSeq !== null && Number.isFinite(maxSeq) && envelope.seq <= maxSeq) {
      return {
        claimed: false,
        reason: "out_of_order_or_duplicate_seq",
      };
    }

    if (daemonRunStatus === "processing") {
      return {
        claimed: false,
        reason: "duplicate_event",
      };
    }

    const inserted = await tx
      .insert(schema.sdlcLoopSignalInbox)
      .values({
        loopId,
        causeType: "daemon_terminal",
        canonicalCauseId: envelope.eventId,
        signalHeadShaOrNull: null,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
        payload: {
          eventType: "daemon_terminal",
          payloadVersion: envelope.payloadVersion,
          eventId: envelope.eventId,
          runId: envelope.runId,
          seq: envelope.seq,
          threadId,
          threadChatId,
          daemonRunStatus,
          daemonErrorMessage,
          daemonErrorCategory,
        },
      })
      .onConflictDoNothing()
      .returning({ id: schema.sdlcLoopSignalInbox.id });

    if (inserted.length > 0) {
      return {
        claimed: true,
        signalInboxId: inserted[0]!.id,
      };
    }

    return {
      claimed: false,
      reason: "duplicate_event",
    };
  });
}

async function rollbackEnrolledLoopDaemonEventClaim({
  signalInboxId,
  loopId,
  eventId,
}: {
  signalInboxId: string;
  loopId: string;
  eventId: string;
}): Promise<boolean> {
  const rolledBack = await db
    .delete(schema.sdlcLoopSignalInbox)
    .where(
      and(
        eq(schema.sdlcLoopSignalInbox.id, signalInboxId),
        eq(schema.sdlcLoopSignalInbox.loopId, loopId),
        eq(schema.sdlcLoopSignalInbox.causeType, "daemon_terminal"),
        eq(schema.sdlcLoopSignalInbox.canonicalCauseId, eventId),
        eq(
          schema.sdlcLoopSignalInbox.causeIdentityVersion,
          SDLC_CAUSE_IDENTITY_VERSION,
        ),
        isNull(schema.sdlcLoopSignalInbox.committedAt),
        isNull(schema.sdlcLoopSignalInbox.processedAt),
      ),
    )
    .returning({ id: schema.sdlcLoopSignalInbox.id });
  return rolledBack.length > 0;
}

async function commitEnrolledLoopDaemonEventClaim({
  signalInboxId,
  loopId,
  eventId,
}: {
  signalInboxId: string;
  loopId: string;
  eventId: string;
}): Promise<DaemonEventCommitResult> {
  const committedAt = new Date();
  const committed = await db
    .update(schema.sdlcLoopSignalInbox)
    .set({ committedAt })
    .where(
      and(
        eq(schema.sdlcLoopSignalInbox.id, signalInboxId),
        eq(schema.sdlcLoopSignalInbox.loopId, loopId),
        eq(schema.sdlcLoopSignalInbox.causeType, "daemon_terminal"),
        eq(schema.sdlcLoopSignalInbox.canonicalCauseId, eventId),
        eq(
          schema.sdlcLoopSignalInbox.causeIdentityVersion,
          SDLC_CAUSE_IDENTITY_VERSION,
        ),
        isNull(schema.sdlcLoopSignalInbox.committedAt),
        isNull(schema.sdlcLoopSignalInbox.processedAt),
      ),
    )
    .returning({ id: schema.sdlcLoopSignalInbox.id });
  if (committed.length > 0) {
    return {
      committed: true,
      state: "committed_now",
    };
  }

  const existing = await db.query.sdlcLoopSignalInbox.findFirst({
    where: and(
      eq(schema.sdlcLoopSignalInbox.loopId, loopId),
      eq(schema.sdlcLoopSignalInbox.causeType, "daemon_terminal"),
      eq(schema.sdlcLoopSignalInbox.canonicalCauseId, eventId),
      eq(
        schema.sdlcLoopSignalInbox.causeIdentityVersion,
        SDLC_CAUSE_IDENTITY_VERSION,
      ),
    ),
    columns: {
      id: true,
      committedAt: true,
      processedAt: true,
    },
  });
  if (existing?.committedAt || existing?.processedAt) {
    return {
      committed: true,
      state: "already_committed_or_processed",
    };
  }

  return {
    committed: false,
    state: "claim_lost",
  };
}

export async function POST(request: Request) {
  const json: DaemonEventAPIBody = await request.json();
  const daemonVersionHeader =
    request.headers.get(DAEMON_EVENT_VERSION_HEADER) ?? null;
  const daemonCapabilitiesHeader =
    request.headers.get(DAEMON_EVENT_CAPABILITIES_HEADER) ?? null;
  const daemonCapabilities = parseDaemonCapabilitiesHeader(
    daemonCapabilitiesHeader,
  );
  const daemonAdvertisesEnvelopeV2 = daemonCapabilities.has(
    DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
  );
  const {
    messages,
    threadId,
    // Old clients don't send the timezone, so we fallback to UTC
    timezone = "UTC",
    transportMode = "legacy",
    protocolVersion = 1,
  } = json;
  const rawThreadChatId = json.threadChatId;
  const threadChatId =
    typeof rawThreadChatId === "string" && rawThreadChatId.length > 0
      ? rawThreadChatId
      : LEGACY_THREAD_CHAT_ID;
  const envelopeV2 = getDaemonEventEnvelopeV2(json);
  let selfDispatchPayload: SdlcSelfDispatchPayload | null = null;
  const daemonAuthContext = await getDaemonTokenAuthContextOrNull(request);
  if (!daemonAuthContext) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = daemonAuthContext.userId;
  const claims = daemonAuthContext.claims;

  if (daemonAdvertisesEnvelopeV2 && !envelopeV2) {
    return Response.json(
      {
        success: false,
        error: "daemon_event_capability_v2_requires_v2_envelope",
      },
      { status: 400 },
    );
  }

  if (envelopeV2 && !daemonAdvertisesEnvelopeV2) {
    return Response.json(
      {
        success: false,
        error: "daemon_event_v2_envelope_requires_capability_v2",
      },
      { status: 400 },
    );
  }

  if (
    transportMode !== "legacy" &&
    hasNonLegacyDaemonPayload(json) &&
    !hasRequiredThreadChatIdForNonLegacyPayload(rawThreadChatId)
  ) {
    return Response.json(
      {
        success: false,
        error: "daemon_event_non_legacy_requires_thread_chat_id",
      },
      { status: 400 },
    );
  }

  let runContext: Awaited<ReturnType<typeof getAgentRunContextByRunId>> | null =
    null;
  const authoritativeRunId = claims?.runId ?? envelopeV2?.runId ?? null;
  if (authoritativeRunId) {
    runContext = await getAgentRunContextByRunId({
      db,
      runId: authoritativeRunId,
      userId,
    });
    if (!runContext) {
      return Response.json(
        {
          success: false,
          error: "daemon_event_run_context_not_found",
          runId: authoritativeRunId,
        },
        { status: 409 },
      );
    }
  }

  if (envelopeV2 && claims && envelopeV2.runId !== claims.runId) {
    return Response.json(
      {
        success: false,
        error: "daemon_event_run_id_claim_mismatch",
        runId: envelopeV2.runId,
      },
      { status: 401 },
    );
  }

  if (envelopeV2 && !claims) {
    return Response.json(
      {
        success: false,
        error: "daemon_token_claims_required",
        runId: envelopeV2.runId,
      },
      { status: 401 },
    );
  }

  if (claims) {
    if (claims.exp <= Date.now()) {
      return Response.json(
        {
          success: false,
          error: "daemon_token_expired",
          runId: claims.runId,
        },
        { status: 401 },
      );
    }
    if (!runContext) {
      return Response.json(
        {
          success: false,
          error: "daemon_event_run_context_not_found",
          runId: claims.runId,
        },
        { status: 409 },
      );
    }
    if (
      runContext.threadId !== threadId ||
      runContext.threadChatId !== threadChatId ||
      claims.threadId !== threadId ||
      claims.threadChatId !== threadChatId
    ) {
      return Response.json(
        {
          success: false,
          error: "daemon_event_run_context_mismatch",
          runId: runContext.runId,
        },
        { status: 409 },
      );
    }
    if (
      claims.runId !== runContext.runId ||
      claims.threadId !== runContext.threadId ||
      claims.threadChatId !== runContext.threadChatId ||
      claims.sandboxId !== runContext.sandboxId ||
      claims.agent !== runContext.agent ||
      claims.nonce !== runContext.tokenNonce ||
      claims.transportMode !== runContext.transportMode ||
      claims.protocolVersion !== runContext.protocolVersion
    ) {
      return Response.json(
        {
          success: false,
          error: "daemon_token_claim_mismatch",
          runId: runContext.runId,
        },
        { status: 401 },
      );
    }
    if (!daemonAuthContext.keyId || !runContext.daemonTokenKeyId) {
      return Response.json(
        {
          success: false,
          error: "daemon_token_key_missing",
          runId: runContext.runId,
        },
        { status: 401 },
      );
    }
    if (daemonAuthContext.keyId !== runContext.daemonTokenKeyId) {
      return Response.json(
        {
          success: false,
          error: "daemon_token_key_mismatch",
          runId: runContext.runId,
        },
        { status: 401 },
      );
    }
    if (
      transportMode !== runContext.transportMode ||
      protocolVersion !== runContext.protocolVersion
    ) {
      return Response.json(
        {
          success: false,
          error: "daemon_transport_context_mismatch",
          runId: runContext.runId,
        },
        { status: 409 },
      );
    }
    if (
      runContext.status === "completed" ||
      runContext.status === "failed" ||
      runContext.status === "stopped"
    ) {
      const replayedSelfDispatch =
        envelopeV2 && threadChatId !== LEGACY_THREAD_CHAT_ID
          ? await getReplayableSelfDispatch({
              threadChatId,
              sourceEventId: envelopeV2.eventId,
              sourceSeq: envelopeV2.seq,
              sourceRunId: runContext.runId,
            })
          : null;
      return jsonTerminalAckResponse(
        buildTerminalAckState(
          {
            status: 202,
            deduplicated: true,
            reason: "run_terminal_ignored",
            runId: runContext.runId,
            acknowledgedEventId: envelopeV2?.eventId ?? null,
            acknowledgedSeq: envelopeV2?.seq ?? null,
          },
          replayedSelfDispatch,
        ),
      );
    }
  }

  // Heartbeat shortcut: empty messages skip SDLC loop, envelope validation, and
  // run-context status transitions — just extend sandbox life + refresh updatedAt.
  if (messages.length === 0) {
    const result = await handleDaemonEvent({
      messages: [],
      threadId,
      threadChatId,
      userId,
      timezone,
      contextUsage: null,
    });
    if (!result.success) {
      return new Response(result.error, { status: result.status || 500 });
    }
    return Response.json({ success: true });
  }

  const daemonRunStatusFromMessages = deriveRunStatusFromMessages(messages);
  const daemonTerminalErrorInfo = deriveDaemonTerminalErrorInfo(messages);

  const enrolledLoop = await getActiveSdlcLoopForThread({
    db,
    userId,
    threadId,
  });

  // Acknowledge dispatch intent once the run context is still in a
  // dispatch-pending state. Envelope v2 starts at seq=0, so this must be
  // status-based (idempotent), not seq-based.
  if (
    enrolledLoop &&
    envelopeV2 &&
    runContext &&
    (runContext.status === "pending" || runContext.status === "dispatched")
  ) {
    try {
      await handleAckReceived({
        db,
        runId: envelopeV2.runId,
        loopId: enrolledLoop.id,
        threadChatId,
      });
    } catch (ackError) {
      console.warn("[delivery-loop] dispatch intent ack failed, non-blocking", {
        loopId: enrolledLoop.id,
        threadId,
        threadChatId,
        runId: envelopeV2.runId,
        error: ackError,
      });
    }
  }

  let claimedSignalInboxId: string | null = null;
  let claimedProcessingEvent = false;

  const rollbackClaimedSignal = async ({
    reason,
    error,
  }: {
    reason: string;
    error?: unknown;
  }) => {
    if (!enrolledLoop || !envelopeV2 || !claimedSignalInboxId) {
      return;
    }
    try {
      const rolledBack = await rollbackEnrolledLoopDaemonEventClaim({
        signalInboxId: claimedSignalInboxId,
        loopId: enrolledLoop.id,
        eventId: envelopeV2.eventId,
      });
      if (!rolledBack) {
        console.warn(
          "[sdlc-loop] failed to rollback daemon signal claim after downstream failure",
          {
            userId,
            threadId,
            loopId: enrolledLoop.id,
            eventId: envelopeV2.eventId,
            seq: envelopeV2.seq,
            reason,
            error,
          },
        );
      }
    } catch (rollbackError) {
      console.error(
        "[sdlc-loop] daemon signal claim rollback threw after downstream failure",
        {
          userId,
          threadId,
          loopId: enrolledLoop.id,
          eventId: envelopeV2.eventId,
          seq: envelopeV2.seq,
          reason,
          error,
          rollbackError,
        },
      );
    }
  };

  const maybeProcessDaemonTerminalFollowUp = async ({
    tickResult,
    loopId,
    loopVersion,
    sourceRunId,
    eventId,
    seq,
  }: {
    tickResult: Awaited<ReturnType<typeof runBestEffortSdlcSignalInboxTick>>;
    loopId: string;
    loopVersion: number;
    sourceRunId: string;
    eventId: string;
    seq: number;
  }) => {
    if (
      !tickResult.processed ||
      tickResult.causeType !== "daemon_terminal" ||
      tickResult.runtimeAction !== "feedback_follow_up_queued"
    ) {
      return;
    }

    // Circuit breaker: prevent infinite consecutive auto-dispatch loops.
    const completedCount = await countConsecutiveCompletedAutoDispatches({
      loopId,
    });
    if (completedCount >= MAX_CONSECUTIVE_AUTO_DISPATCHES) {
      console.warn(
        "[sdlc-loop] circuit breaker: too many consecutive auto-dispatches, skipping follow-up",
        {
          userId,
          threadId,
          threadChatId,
          loopId,
          completedCount,
          threshold: MAX_CONSECUTIVE_AUTO_DISPATCHES,
          eventId,
          seq,
        },
      );
      return;
    }

    // Check if daemon supports self-dispatch.
    const daemonSupportsSelfDispatch = daemonCapabilities.has(
      DAEMON_CAPABILITY_SDLC_SELF_DISPATCH,
    );

    if (daemonSupportsSelfDispatch) {
      const userFeatureFlags = await getFeatureFlagsForUser({ db, userId });
      let preparedDispatch: { intentId: string; runId: string } | null = null;
      try {
        // Use the queued message directly from the tick result to avoid
        // a race with handleThreadFinish's maybeProcessFollowUpQueue which
        // can consume queued messages from the DB before we read them.
        const feedbackMsg = tickResult.feedbackQueuedMessage;
        if (!feedbackMsg) {
          console.warn(
            "[sdlc-loop] self-dispatch: no feedback message from tick result, falling back",
            { userId, threadId, threadChatId, loopId },
          );
          // Fall through to existing path
        } else {
          // Also need thread chat for agent info
          const [threadChatForDispatch, threadForDispatch] = await Promise.all([
            getThreadChat({ db, userId, threadId, threadChatId }),
            getThreadMinimal({ db, threadId, userId }),
          ]);
          if (!threadChatForDispatch) {
            console.warn(
              "[sdlc-loop] self-dispatch: thread chat not found, falling back",
              { userId, threadId, threadChatId, loopId },
            );
          } else if (!threadForDispatch || !threadForDispatch.codesandboxId) {
            console.warn(
              "[sdlc-loop] self-dispatch: thread or sandbox not found, falling back",
              { userId, threadId, loopId },
            );
          } else {
            // Build prompt from the feedback message (text parts only).
            // If any non-text parts exist, fall back to the queue path
            // which handles the full message format.
            const queuedMessages = [feedbackMsg];
            const promptParts: string[] = [];
            let hasNonTextParts = false;
            for (const qMsg of queuedMessages) {
              if ("parts" in qMsg && Array.isArray(qMsg.parts)) {
                for (const part of qMsg.parts) {
                  if (
                    part &&
                    typeof part === "object" &&
                    "text" in part &&
                    typeof part.text === "string"
                  ) {
                    promptParts.push(part.text);
                  } else if (part && typeof part === "object") {
                    hasNonTextParts = true;
                  }
                }
              }
            }

            if (hasNonTextParts) {
              console.warn(
                "[sdlc-loop] self-dispatch: non-text message parts detected, falling back",
                { userId, threadId, threadChatId, loopId },
              );
            } else if (!promptParts.join("\n\n").trim()) {
              console.warn(
                "[sdlc-loop] self-dispatch: empty prompt from queued messages, falling back",
                { userId, threadId, threadChatId, loopId },
              );
            } else {
              const prompt = promptParts.join("\n\n");
              // Transition status first WITHOUT chat updates to avoid clearing
              // queued messages on failure (chatUpdates apply unconditionally).
              const { didUpdateStatus } = await updateThreadChatWithTransition({
                userId,
                threadId,
                threadChatId,
                eventType: "user.message",
              });

              if (!didUpdateStatus) {
                console.warn(
                  "[sdlc-loop] self-dispatch: status transition failed, falling back",
                  { userId, threadId, threadChatId, loopId },
                );
              } else {
                const newRunId = randomUUID();
                const newTokenNonce = randomUUID();
                const agent = threadChatForDispatch.agent;
                const agentVersion = threadChatForDispatch.agentVersion;
                const model = normalizedModelForDaemon(
                  getDefaultModelForAgent({ agent, agentVersion }),
                );
                const sandboxId = threadForDispatch.codesandboxId;

                // SDLC follow-ups always use allowAll — same as startAgentMessage
                // which forces allowAll when activeSdlcLoop is true.
                const effectivePermissionMode = "allowAll" as const;
                const supportsAcp =
                  agent === "codex" || agent === "amp" || agent === "opencode";
                const shouldUseCodexAppServerTransport =
                  agent === "codex" && userFeatureFlags.codexAppServerTransport;
                const shouldUseAcpTransport =
                  !shouldUseCodexAppServerTransport &&
                  userFeatureFlags.sandboxAgentAcpTransport &&
                  supportsAcp;
                const transportMode = shouldUseCodexAppServerTransport
                  ? ("codex-app-server" as const)
                  : shouldUseAcpTransport
                    ? ("acp" as const)
                    : ("legacy" as const);
                const protocolVersion: 1 | 2 = transportMode === "acp" ? 2 : 1;

                // Create run context
                await upsertAgentRunContext({
                  db,
                  runId: newRunId,
                  userId,
                  threadId,
                  threadChatId,
                  sandboxId,
                  transportMode,
                  protocolVersion,
                  agent,
                  permissionMode: effectivePermissionMode,
                  requestedSessionId: null,
                  resolvedSessionId: null,
                  status: "pending",
                  tokenNonce: newTokenNonce,
                  daemonTokenKeyId: null,
                });

                // Create API key
                const { token } = await createDaemonRunCredentials({
                  userId,
                  threadId,
                  threadChatId,
                  sandboxId,
                  runId: newRunId,
                  tokenNonce: newTokenNonce,
                  agent,
                  transportMode,
                  protocolVersion,
                });

                await updateThreadChat({
                  db,
                  userId,
                  threadId,
                  threadChatId,
                  updates: {
                    errorMessage: null,
                    errorMessageInfo: null,
                  },
                });

                // Persist dispatch intent before sending payload to daemon
                const dispatchIntent = await createDispatchIntent({
                  loopId,
                  threadId,
                  threadChatId,
                  targetPhase: "implementing",
                  selectedAgent: agent as DeliveryLoopSelectedAgent,
                  executionClass: "implementation_runtime",
                  dispatchMechanism: "self_dispatch",
                  runId: newRunId,
                  maxRetries: 3,
                });
                preparedDispatch = {
                  intentId: dispatchIntent.id,
                  runId: newRunId,
                };

                const userCredentials = await getUserCredentials({ userId });
                const useCredits = shouldUseCredits(agent, userCredentials);

                const preparedSelfDispatchPayload = {
                  token,
                  prompt,
                  runId: newRunId,
                  tokenNonce: newTokenNonce,
                  model,
                  agent,
                  agentVersion,
                  sessionId: null,
                  featureFlags: userFeatureFlags,
                  permissionMode: effectivePermissionMode,
                  transportMode,
                  protocolVersion,
                  threadId,
                  threadChatId,
                  useCredits: useCredits || undefined,
                };
                await storeSelfDispatchReplay({
                  threadChatId,
                  sourceEventId: eventId,
                  sourceSeq: seq,
                  sourceRunId,
                  dispatchIntentId: dispatchIntent.id,
                  destinationRunId: newRunId,
                  payload: preparedSelfDispatchPayload,
                });
                await updateDispatchIntent(dispatchIntent.id, threadChatId, {
                  status: "dispatched",
                });
                try {
                  await markDispatchIntentDispatched(db, newRunId);
                } catch (dispatchTransitionError) {
                  console.warn(
                    "[delivery-loop] failed to mark durable dispatch intent as dispatched",
                    {
                      loopId,
                      threadId,
                      threadChatId,
                      runId: newRunId,
                      error: dispatchTransitionError,
                    },
                  );
                }
                // Only arm the timeout once the replay record exists and the
                // self-dispatch payload is actually recoverable on retries.
                startAckTimeout({
                  db,
                  runId: newRunId,
                  loopId,
                  threadChatId,
                });
                selfDispatchPayload = preparedSelfDispatchPayload;

                console.log("[sdlc-loop] self-dispatch payload prepared", {
                  userId,
                  threadId,
                  threadChatId,
                  loopId,
                  runId: newRunId,
                  eventId,
                  seq,
                });
                return; // Skip maybeProcessFollowUpQueue
              }
            }
          }
        }
      } catch (error) {
        if (preparedDispatch) {
          try {
            await Promise.all([
              updateDispatchIntent(preparedDispatch.intentId, threadChatId, {
                status: "failed",
                lastError:
                  error instanceof Error
                    ? error.message
                    : "self-dispatch preparation failed",
                lastFailureCategory: "config_error",
              }),
              updateAgentRunContext({
                db,
                runId: preparedDispatch.runId,
                userId,
                updates: {
                  status: "failed",
                },
              }),
            ]);
          } catch (cleanupError) {
            console.error(
              "[sdlc-loop] failed to clean up abandoned self-dispatch run",
              {
                userId,
                threadId,
                threadChatId,
                loopId,
                runId: preparedDispatch.runId,
                cleanupError,
              },
            );
          }
        }
        console.error(
          "[sdlc-loop] self-dispatch preparation failed, falling back to queue",
          {
            userId,
            threadId,
            threadChatId,
            loopId,
            eventId,
            seq,
            error,
          },
        );
      }
    }

    // Existing fallback path
    let followUpResult = await maybeProcessFollowUpQueue({
      threadId,
      threadChatId,
      userId,
      runId: runContext?.runId ?? envelopeV2?.runId ?? null,
    });
    console.log(
      "[sdlc-loop] daemon terminal follow-up queue processing completed",
      {
        userId,
        threadId,
        threadChatId,
        loopId,
        runId: runContext?.runId ?? envelopeV2?.runId ?? null,
        eventId,
        seq,
        runtimeRouting: tickResult.runtimeRouting ?? null,
        followUpResult,
      },
    );

    if (
      !followUpResult.processed &&
      followUpResult.reason === "no_queued_messages" &&
      tickResult.feedbackQueuedMessage
    ) {
      console.warn(
        "[sdlc-loop] daemon terminal follow-up invariant violated; re-enqueueing feedback message",
        {
          userId,
          threadId,
          threadChatId,
          loopId,
          runId: runContext?.runId ?? envelopeV2?.runId ?? null,
          eventId,
          seq,
        },
      );
      await queueFollowUpInternal({
        userId,
        threadId,
        threadChatId,
        messages: [tickResult.feedbackQueuedMessage],
        appendOrReplace: "append",
        source: "github",
      });
      followUpResult = await maybeProcessFollowUpQueue({
        threadId,
        threadChatId,
        userId,
        runId: runContext?.runId ?? envelopeV2?.runId ?? null,
      });
      console.log(
        "[sdlc-loop] daemon terminal follow-up queue recovery completed",
        {
          userId,
          threadId,
          threadChatId,
          loopId,
          runId: runContext?.runId ?? envelopeV2?.runId ?? null,
          eventId,
          seq,
          followUpResult,
        },
      );
    }

    if (
      followUpResult.processed ||
      followUpResult.reason !== "stale_cas_busy"
    ) {
      return;
    }

    const recoveryKey = getDeliveryLoopDaemonRecoveryKey({
      loopId,
      loopVersion,
    });
    const didScheduleRecovery = await redis.set(recoveryKey, "1", {
      nx: true,
      ex: SDLC_DAEMON_RECOVERY_TTL_SECONDS,
    });
    if (didScheduleRecovery !== "OK") {
      return;
    }

    waitUntil(
      (async () => {
        await sleep(1_500);
        const retryResult = await maybeProcessFollowUpQueue({
          threadId,
          threadChatId,
          userId,
          runId: runContext?.runId ?? envelopeV2?.runId ?? null,
        });
        console.log("[sdlc-loop] daemon follow-up recovery retry completed", {
          userId,
          threadId,
          threadChatId,
          loopId,
          loopVersion,
          runId: runContext?.runId ?? envelopeV2?.runId ?? null,
          eventId,
          seq,
          retryResult,
        });
      })(),
    );
  };

  if (enrolledLoop) {
    if (!envelopeV2) {
      console.error(
        "[sdlc-loop] rejecting daemon event for enrolled loop without v2 envelope",
        {
          userId,
          threadId,
          loopId: enrolledLoop.id,
          daemonVersionHeader,
          daemonCapabilitiesHeader,
          payloadVersion: json.payloadVersion ?? null,
        },
      );
      return Response.json(
        {
          success: false,
          error: "enrolled_loop_requires_v2_envelope",
          loopId: enrolledLoop.id,
        },
        { status: 409 },
      );
    }

    if (envelopeV2 && daemonRunStatusFromMessages === "processing") {
      const processingClaimResult = await claimEnrolledLoopProcessingEvent({
        loopId: enrolledLoop.id,
        envelope: envelopeV2,
      });
      if (!processingClaimResult.claimed) {
        if (processingClaimResult.reason === "claim_in_progress") {
          return Response.json(
            {
              success: false,
              error: "daemon_event_claim_in_progress",
              loopId: enrolledLoop.id,
            },
            { status: 409 },
          );
        }
        return Response.json(
          {
            success: true,
            deduplicated: true,
            reason: processingClaimResult.reason,
            loopId: enrolledLoop.id,
            acknowledgedEventId: envelopeV2.eventId,
            acknowledgedSeq: envelopeV2.seq,
          },
          { status: 202 },
        );
      }
      claimedProcessingEvent = true;
    } else if (envelopeV2) {
      const claimResult = await claimEnrolledLoopDaemonEvent({
        loopId: enrolledLoop.id,
        threadId,
        threadChatId,
        envelope: envelopeV2,
        daemonRunStatus: daemonRunStatusFromMessages,
        daemonErrorMessage: daemonTerminalErrorInfo.errorMessage,
        daemonErrorCategory: daemonTerminalErrorInfo.errorCategory,
      });
      if (!claimResult.claimed) {
        if (claimResult.reason === "claim_in_progress") {
          return Response.json(
            {
              success: false,
              error: "daemon_event_claim_in_progress",
              loopId: enrolledLoop.id,
            },
            { status: 409 },
          );
        }
        try {
          await persistDaemonTerminalDispatchStatus({
            loopId: enrolledLoop.id,
            threadChatId,
            runId: envelopeV2.runId,
            daemonRunStatus: daemonRunStatusFromMessages,
            daemonErrorMessage: daemonTerminalErrorInfo.errorMessage,
            daemonErrorCategory: daemonTerminalErrorInfo.errorCategory,
          });
        } catch (error) {
          console.warn(
            "[delivery-loop] failed to persist terminal dispatch intent status on dedupe",
            {
              loopId: enrolledLoop.id,
              threadId,
              threadChatId,
              runId: envelopeV2.runId,
              daemonRunStatus: daemonRunStatusFromMessages,
              reason: claimResult.reason,
              error,
            },
          );
        }
        if (claimResult.reason === "duplicate_event") {
          try {
            const guardrailRuntime = buildCoordinatorGuardrailRuntime(
              enrolledLoop.loopVersion,
            );
            const signalTickResult = await runBestEffortSdlcSignalInboxTick({
              db,
              loopId: enrolledLoop.id,
              leaseOwnerToken: `daemon-event-dedup:${envelopeV2.eventId}:${envelopeV2.seq}`,
              guardrailRuntime,
              includeRuntimeRouting: true,
            });
            await maybeProcessDaemonTerminalFollowUp({
              tickResult: signalTickResult,
              loopId: enrolledLoop.id,
              loopVersion: enrolledLoop.loopVersion,
              sourceRunId: envelopeV2.runId,
              eventId: envelopeV2.eventId,
              seq: envelopeV2.seq,
            });
            await runBestEffortSdlcPublicationCoordinator({
              db,
              loopId: enrolledLoop.id,
              leaseOwnerToken: `daemon-event-dedup:${envelopeV2.eventId}:${envelopeV2.seq}`,
              guardrailRuntime,
            });
          } catch (error) {
            console.error(
              "[sdlc-loop] duplicate daemon event dedupe tick failed",
              {
                userId,
                threadId,
                loopId: enrolledLoop.id,
                eventId: envelopeV2.eventId,
                seq: envelopeV2.seq,
                reason: claimResult.reason,
                error,
              },
            );
            return new Response(
              "failed to process deduplicated daemon event signal",
              { status: 500 },
            );
          }
        }
        const replayedSelfDispatch = await getReplayableSelfDispatch({
          threadChatId,
          sourceEventId: envelopeV2.eventId,
          sourceSeq: envelopeV2.seq,
          sourceRunId: envelopeV2.runId,
        });
        return jsonTerminalAckResponse(
          buildTerminalAckState(
            {
              status: 202,
              deduplicated: true,
              reason: claimResult.reason,
              loopId: enrolledLoop.id,
              acknowledgedEventId: envelopeV2.eventId,
              acknowledgedSeq: envelopeV2.seq,
            },
            replayedSelfDispatch,
          ),
        );
      }
      claimedSignalInboxId = claimResult.signalInboxId;
    }
  }

  // Prefer computing context usage from the last non-result message's usage
  // fields when available. Do not sum across all messages.
  const computedContextUsage = (() => {
    try {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as any;
        if (!m || m.type === "result") continue;
        const usage = m.message?.usage;
        if (!usage) continue;
        if (m.parent_tool_use_id) continue;
        const input = Number(usage.input_tokens ?? 0);
        const output = Number(usage.output_tokens ?? 0);
        const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
        const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
        const total = input + output + cacheCreate + cacheRead;
        return Number.isFinite(total) && total > 0 ? total : null;
      }
      return null;
    } catch (_e) {
      return null;
    }
  })();
  let result: Awaited<ReturnType<typeof handleDaemonEvent>>;
  if (
    runContext &&
    (runContext.status === "pending" || runContext.status === "dispatched")
  ) {
    await updateAgentRunContext({
      db,
      userId,
      runId: runContext.runId,
      updates: {
        status: "processing",
      },
    });
  }
  try {
    result = await handleDaemonEvent({
      messages,
      threadId,
      threadChatId,
      userId,
      timezone,
      contextUsage: computedContextUsage ?? null,
      runId: runContext?.runId ?? envelopeV2?.runId ?? null,
    });
  } catch (error) {
    if (runContext) {
      await updateAgentRunContext({
        db,
        userId,
        runId: runContext.runId,
        updates: {
          status: "failed",
        },
      });
    }
    if (enrolledLoop && envelopeV2 && claimedProcessingEvent) {
      await rollbackEnrolledLoopProcessingEventClaim({
        loopId: enrolledLoop.id,
        envelope: envelopeV2,
      });
    }
    await rollbackClaimedSignal({
      reason: "handle_daemon_event_threw",
      error,
    });
    throw error;
  }

  if (!result.success) {
    if (runContext) {
      await updateAgentRunContext({
        db,
        userId,
        runId: runContext.runId,
        updates: {
          status: "failed",
        },
      });
    }
    if (enrolledLoop && envelopeV2 && claimedProcessingEvent) {
      await rollbackEnrolledLoopProcessingEventClaim({
        loopId: enrolledLoop.id,
        envelope: envelopeV2,
      });
    }
    await rollbackClaimedSignal({
      reason: "handle_daemon_event_failed",
      error: result.error,
    });
    return new Response(result.error, { status: result.status || 500 });
  }

  if (enrolledLoop && envelopeV2 && claimedProcessingEvent) {
    await commitEnrolledLoopProcessingEvent({
      loopId: enrolledLoop.id,
      envelope: envelopeV2,
    });
  }

  const resolvedSessionId = deriveSessionIdFromMessages(messages);
  const resolvedStatus = daemonRunStatusFromMessages;

  if (runContext) {
    await updateAgentRunContext({
      db,
      userId,
      runId: runContext.runId,
      updates: {
        resolvedSessionId,
        status: resolvedStatus,
      },
    });
  }

  if (resolvedStatus === "failed") {
    console.warn("[daemon-event] daemon run ended with terminal failure", {
      userId,
      threadId,
      threadChatId,
      runId: runContext?.runId ?? envelopeV2?.runId ?? null,
      errorCategory: daemonTerminalErrorInfo.errorCategory,
      errorMessage: daemonTerminalErrorInfo.errorMessage,
    });
  }

  if (
    resolvedStatus === "completed" &&
    json.codexPreviousResponseId !== undefined
  ) {
    if (
      json.codexPreviousResponseId !== null &&
      typeof json.codexPreviousResponseId !== "string"
    ) {
      await rollbackClaimedSignal({
        reason: "invalid_codex_previous_response_id",
        error: json.codexPreviousResponseId,
      });
      return Response.json(
        {
          success: false,
          error: "invalid_codex_previous_response_id",
        },
        { status: 400 },
      );
    }

    const shouldPersistCodexPreviousResponseId =
      transportMode === "codex-app-server" ||
      json.codexPreviousResponseId === null;
    if (shouldPersistCodexPreviousResponseId) {
      try {
        await db
          .update(schema.threadChat)
          .set({
            codexPreviousResponseId: json.codexPreviousResponseId,
          })
          .where(
            and(
              eq(schema.threadChat.userId, userId),
              eq(schema.threadChat.threadId, threadId),
              eq(schema.threadChat.id, threadChatId),
            ),
          );
      } catch (error) {
        console.error(
          "[daemon-event] failed to persist codexPreviousResponseId; continuing without rollback",
          {
            userId,
            threadId,
            threadChatId,
            transportMode,
            codexPreviousResponseId: json.codexPreviousResponseId,
            error,
          },
        );
      }
    }
  }

  if (enrolledLoop && envelopeV2 && claimedSignalInboxId) {
    const commitResult = await commitEnrolledLoopDaemonEventClaim({
      signalInboxId: claimedSignalInboxId,
      loopId: enrolledLoop.id,
      eventId: envelopeV2.eventId,
    });
    if (!commitResult.committed) {
      console.error(
        "[sdlc-loop] failed to mark daemon signal claim as committed",
        {
          userId,
          threadId,
          loopId: enrolledLoop.id,
          signalInboxId: claimedSignalInboxId,
          eventId: envelopeV2.eventId,
          seq: envelopeV2.seq,
          commitState: commitResult.state,
        },
      );
      return new Response("failed to commit daemon event claim", {
        status: 500,
      });
    }
    if (commitResult.state === "already_committed_or_processed") {
      console.warn(
        "[sdlc-loop] daemon signal claim already committed or processed before commit step",
        {
          userId,
          threadId,
          loopId: enrolledLoop.id,
          signalInboxId: claimedSignalInboxId,
          eventId: envelopeV2.eventId,
          seq: envelopeV2.seq,
        },
      );
    }
  }

  if (
    enrolledLoop &&
    envelopeV2 &&
    daemonRunStatusFromMessages !== "processing"
  ) {
    try {
      await persistDaemonTerminalDispatchStatus({
        loopId: enrolledLoop.id,
        threadChatId,
        runId: envelopeV2.runId,
        daemonRunStatus: daemonRunStatusFromMessages,
        daemonErrorMessage: daemonTerminalErrorInfo.errorMessage,
        daemonErrorCategory: daemonTerminalErrorInfo.errorCategory,
      });
    } catch (error) {
      console.warn(
        "[delivery-loop] failed to persist terminal dispatch intent status",
        {
          loopId: enrolledLoop.id,
          threadId,
          threadChatId,
          runId: envelopeV2.runId,
          daemonRunStatus: daemonRunStatusFromMessages,
          error,
        },
      );
    }
  }

  if (enrolledLoop && envelopeV2) {
    try {
      const guardrailRuntime = buildCoordinatorGuardrailRuntime(
        enrolledLoop.loopVersion,
      );
      const signalTickResult = await runBestEffortSdlcSignalInboxTick({
        db,
        loopId: enrolledLoop.id,
        leaseOwnerToken: `daemon-event:${envelopeV2.eventId}:${envelopeV2.seq}`,
        guardrailRuntime,
        includeRuntimeRouting: true,
      });
      await maybeProcessDaemonTerminalFollowUp({
        tickResult: signalTickResult,
        loopId: enrolledLoop.id,
        loopVersion: enrolledLoop.loopVersion,
        sourceRunId: envelopeV2.runId,
        eventId: envelopeV2.eventId,
        seq: envelopeV2.seq,
      });
      if (!signalTickResult.processed) {
        console.log(
          "[sdlc-loop] daemon event tick skipped follow-up dispatch",
          {
            userId,
            threadId,
            threadChatId,
            loopId: enrolledLoop.id,
            eventId: envelopeV2.eventId,
            seq: envelopeV2.seq,
            reason: signalTickResult.reason,
          },
        );
      }

      await runBestEffortSdlcPublicationCoordinator({
        db,
        loopId: enrolledLoop.id,
        leaseOwnerToken: `daemon-event:${envelopeV2.eventId}:${envelopeV2.seq}`,
        guardrailRuntime,
      });
    } catch (error) {
      console.error(
        "[sdlc-loop] best-effort publication coordinator tick failed",
        {
          userId,
          threadId,
          loopId: enrolledLoop.id,
          eventId: envelopeV2.eventId,
          seq: envelopeV2.seq,
          error,
        },
      );
    }
  }

  return jsonTerminalAckResponse(
    buildTerminalAckState(
      {
        acknowledgedEventId: envelopeV2?.eventId ?? null,
        acknowledgedSeq: envelopeV2?.seq ?? null,
      },
      selfDispatchPayload,
    ),
  );
}

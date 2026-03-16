import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import {
  DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
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
  markDispatchIntentCompleted,
  markDispatchIntentFailed,
  type DeliveryLoopFailureCategory,
} from "@terragon/shared/model/delivery-loop";
import {
  buildDispatchIntentId,
  getReplayableSelfDispatch,
  updateDispatchIntent,
} from "@/server-lib/delivery-loop/dispatch-intent";
import { handleAckReceived } from "@/server-lib/delivery-loop/ack-lifecycle";
import {
  getAgentRunContextByRunId,
  updateAgentRunContext,
} from "@terragon/shared/model/agent-run-context";
import { and, eq, isNull, sql } from "drizzle-orm";
import { runCoordinatorTick } from "@/server-lib/delivery-loop/coordinator/tick";
import { ensureV2WorkflowExists } from "@/server-lib/delivery-loop/coordinator/enrollment-bridge";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import type {
  WorkflowId,
  CorrelationId,
} from "@terragon/shared/delivery-loop/domain/workflow";
import { redis } from "@/lib/redis";

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
const DAEMON_PROCESSING_EVENT_CLAIM_TTL_SECONDS = 60;
const DAEMON_PROCESSING_EVENT_COMMITTED_TTL_SECONDS = 60 * 60 * 24;

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
  headShaAtCompletion,
}: {
  loopId: string;
  threadId: string;
  threadChatId: string;
  envelope: DaemonEventEnvelopeV2;
  daemonRunStatus: "processing" | "completed" | "failed" | "stopped";
  daemonErrorMessage: string | null;
  daemonErrorCategory: DaemonTerminalErrorCategory;
  headShaAtCompletion: string | null;
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
          ...(headShaAtCompletion ? { headShaAtCompletion } : {}),
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
        headShaAtCompletion:
          typeof json.headShaAtCompletion === "string"
            ? json.headShaAtCompletion
            : null,
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
        if (daemonRunStatusFromMessages !== "processing") {
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
        }
        if (claimResult.reason === "duplicate_event") {
          try {
            let v2Workflow = await getActiveWorkflowForThread({
              db,
              threadId,
            });
            if (!v2Workflow) {
              const { workflowId: backfilledDedupId } =
                await ensureV2WorkflowExists({
                  db,
                  threadId,
                  sdlcLoopId: enrolledLoop.id,
                  sdlcLoopState: enrolledLoop.state,
                  sdlcBlockedFromState: enrolledLoop.blockedFromState,
                });
              v2Workflow = { id: backfilledDedupId } as NonNullable<
                Awaited<ReturnType<typeof getActiveWorkflowForThread>>
              >;
            }
            if (v2Workflow) {
              await runCoordinatorTick({
                db,
                workflowId: v2Workflow.id as WorkflowId,
                correlationId:
                  `daemon-event-dedup:${envelopeV2.eventId}:${envelopeV2.seq}` as CorrelationId,
                claimToken: `daemon-event-dedup:${envelopeV2.eventId}:${envelopeV2.seq}`,
                loopId: enrolledLoop.id,
              });
            }
          } catch (error) {
            console.error(
              "[sdlc-loop] duplicate daemon event dedupe tick failed — FULL ERROR:",
              error,
            );
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
    console.error(
      "[daemon-event] UNHANDLED ERROR in main processing — FULL ERROR:",
      error,
    );
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

  const resolvedSessionId = deriveSessionIdFromMessages(messages);
  const resolvedStatus = daemonRunStatusFromMessages;

  // Processing event commit and run context update are independent — batch them.
  {
    const postHandleOps: Array<Promise<unknown>> = [];
    if (enrolledLoop && envelopeV2 && claimedProcessingEvent) {
      postHandleOps.push(
        commitEnrolledLoopProcessingEvent({
          loopId: enrolledLoop.id,
          envelope: envelopeV2,
        }),
      );
    }
    if (runContext) {
      postHandleOps.push(
        updateAgentRunContext({
          db,
          userId,
          runId: runContext.runId,
          updates: {
            resolvedSessionId,
            status: resolvedStatus,
          },
        }),
      );
    }
    if (postHandleOps.length > 0) {
      await Promise.all(postHandleOps);
    }
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
      // Invalid type — skip codex persistence but do NOT rollback claimed
      // signal. Rolling back after terminal side effects would permanently
      // lose the daemon completion signal for enrolled loops.
      console.warn(
        "[daemon-event] invalid codexPreviousResponseId type, skipping persistence",
        {
          userId,
          threadId,
          threadChatId,
          codexPreviousResponseId: json.codexPreviousResponseId,
        },
      );
    } else {
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
  }

  // Signal commit and dispatch status persistence are independent — run
  // them concurrently. The dispatch status is best-effort (errors are
  // warnings), while the signal commit is required before the inbox tick.
  if (enrolledLoop && envelopeV2) {
    const dispatchStatusPromise =
      daemonRunStatusFromMessages !== "processing"
        ? persistDaemonTerminalDispatchStatus({
            loopId: enrolledLoop.id,
            threadChatId,
            runId: envelopeV2.runId,
            daemonRunStatus: daemonRunStatusFromMessages,
            daemonErrorMessage: daemonTerminalErrorInfo.errorMessage,
            daemonErrorCategory: daemonTerminalErrorInfo.errorCategory,
          }).catch((error) => {
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
          })
        : null;

    if (claimedSignalInboxId) {
      const [commitResult] = await Promise.all([
        commitEnrolledLoopDaemonEventClaim({
          signalInboxId: claimedSignalInboxId,
          loopId: enrolledLoop.id,
          eventId: envelopeV2.eventId,
        }),
        dispatchStatusPromise,
      ]);
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
    } else if (dispatchStatusPromise) {
      await dispatchStatusPromise;
    }
  }

  if (enrolledLoop && envelopeV2) {
    try {
      const v2Workflow = await getActiveWorkflowForThread({
        db,
        threadId,
      });
      if (v2Workflow) {
        const tickResult = await runCoordinatorTick({
          db,
          workflowId: v2Workflow.id as WorkflowId,
          correlationId:
            `daemon-event:${envelopeV2.eventId}:${envelopeV2.seq}` as CorrelationId,
          claimToken: `daemon-event:${envelopeV2.eventId}:${envelopeV2.seq}`,
          loopId: enrolledLoop.id,
        });
        if (!tickResult.signalsProcessed) {
          console.log(
            "[sdlc-loop-v2] daemon event coordinator tick processed no signals",
            {
              userId,
              threadId,
              threadChatId,
              workflowId: v2Workflow.id,
              eventId: envelopeV2.eventId,
              seq: envelopeV2.seq,
            },
          );
        }
      } else {
        // No v2 workflow — backfill from the enrolled v1 loop so the
        // committed daemon signal gets processed on this tick.
        console.warn(
          "[sdlc-loop-v2] daemon event has no v2 workflow — backfilling from v1 loop",
          {
            userId,
            threadId,
            threadChatId,
            loopId: enrolledLoop.id,
            eventId: envelopeV2.eventId,
            seq: envelopeV2.seq,
          },
        );
        const { workflowId: backfilledId } = await ensureV2WorkflowExists({
          db,
          threadId,
          sdlcLoopId: enrolledLoop.id,
          sdlcLoopState: enrolledLoop.state,
          sdlcBlockedFromState: enrolledLoop.blockedFromState,
        });
        await runCoordinatorTick({
          db,
          workflowId: backfilledId as WorkflowId,
          correlationId:
            `daemon-event:${envelopeV2.eventId}:${envelopeV2.seq}` as CorrelationId,
          claimToken: `daemon-event:${envelopeV2.eventId}:${envelopeV2.seq}`,
          loopId: enrolledLoop.id,
        });
      }
    } catch (error) {
      console.error("[sdlc-loop] best-effort coordinator tick failed", {
        userId,
        threadId,
        loopId: enrolledLoop.id,
        eventId: envelopeV2.eventId,
        seq: envelopeV2.seq,
        error,
      });
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

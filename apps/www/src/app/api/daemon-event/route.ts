import {
  getDaemonTokenAuthContextOrNull,
  type DaemonTokenAuthContext,
} from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import {
  publishBroadcastUserMessage,
  publishDeltaBroadcast,
} from "@terragon/shared/broadcast-server";
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
  markDispatchIntentCompleted,
  markDispatchIntentFailed,
} from "@terragon/shared/delivery-loop/store/dispatch-intent-store";
import {
  type DaemonTerminalErrorCategory,
  classifyDaemonTerminalErrorCategory,
  mapDaemonTerminalCategoryToFailureCategory,
} from "@terragon/shared/delivery-loop/domain/failure";
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
import { appendTokenStreamEvents } from "@terragon/shared/model/token-stream-event";
import { and, eq } from "drizzle-orm";
import {
  isLocalRedisHttpMode,
  isRedisTransportParseError,
  redis,
} from "@/lib/redis";
import { appendEventAndAdvanceExplicit } from "@/server-lib/delivery-loop/v3/kernel";
import {
  getActiveWorkflowForThread,
  getWorkflowHead,
} from "@/server-lib/delivery-loop/v3/store";
import { getDaemonEventDbPreflight } from "@/server-lib/daemon-event-db-preflight";
import {
  buildDeltaSequenceKey,
  computeMaxSeqByKey,
  type DeltaSequenceKey,
  filterDeltasByKnownMaxSeq,
  normalizeDeltasForPersistence,
} from "@/server-lib/token-stream-guards";
import { env } from "@terragon/env/apps-www";

type DaemonEventEnvelopeV2 = {
  payloadVersion: 2;
  eventId: string;
  runId: string;
  seq: number;
};

const DAEMON_PROCESSING_EVENT_CLAIM_TTL_SECONDS = 60;
const DAEMON_PROCESSING_EVENT_COMMITTED_TTL_SECONDS = 60 * 60 * 24;
const DELTA_SEQ_MAX_TTL_SECONDS = 60 * 60 * 24;
const DAEMON_TEST_AUTH_HEADER = "X-Terragon-Test-Daemon-Auth";
const DAEMON_TEST_USER_ID_HEADER = "X-Terragon-Test-User-Id";
const DAEMON_TEST_AUTH_ENABLED_VALUE = "enabled";

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

function getDeltaSeqMaxRedisKey(sequenceKey: string): string {
  return `sdlc:delta-seq-max:${sequenceKey}`;
}

function isMissingSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if (!("code" in error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === "42P01" || code === "42703";
}

async function getKnownMaxDeltaSeqByKey(params: {
  runId: string;
  deltas: DaemonEventAPIBody["deltas"];
}): Promise<Map<DeltaSequenceKey, number>> {
  const result = new Map<DeltaSequenceKey, number>();
  if (!params.deltas || params.deltas.length === 0 || isLocalRedisHttpMode()) {
    return result;
  }

  for (const delta of params.deltas) {
    const sequenceKey = buildDeltaSequenceKey({
      runId: params.runId,
      messageId: delta.messageId,
      partIndex: delta.partIndex,
      kind: delta.kind === "thinking" ? "thinking" : "text",
    });
    if (result.has(sequenceKey)) {
      continue;
    }
    try {
      const raw = await redis.get<string>(getDeltaSeqMaxRedisKey(sequenceKey));
      const parsed = raw == null ? Number.NaN : Number(raw);
      if (Number.isFinite(parsed)) {
        result.set(sequenceKey, parsed);
      }
    } catch (error) {
      if (isLocalRedisHttpMode() && isRedisTransportParseError(error)) {
        console.warn(
          "[daemon-event] local redis delta max-seq read parse failure, bypassing",
          { sequenceKey },
        );
        return new Map();
      }
      throw error;
    }
  }

  return result;
}

async function persistKnownMaxDeltaSeqByKey(params: {
  runId: string;
  deltas: DaemonEventAPIBody["deltas"];
}): Promise<void> {
  if (!params.deltas || params.deltas.length === 0 || isLocalRedisHttpMode()) {
    return;
  }
  const maxByKey = computeMaxSeqByKey({
    runId: params.runId,
    deltas: params.deltas,
  });
  for (const [sequenceKey, maxSeq] of maxByKey) {
    try {
      await redis.set(getDeltaSeqMaxRedisKey(sequenceKey), String(maxSeq), {
        ex: DELTA_SEQ_MAX_TTL_SECONDS,
      });
    } catch (error) {
      if (isLocalRedisHttpMode() && isRedisTransportParseError(error)) {
        console.warn(
          "[daemon-event] local redis delta max-seq write parse failure, bypassing",
          { sequenceKey, maxSeq },
        );
        return;
      }
      throw error;
    }
  }
}

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
    params.daemonErrorMessage,
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
  if (isLocalRedisHttpMode()) {
    // Local redis-http can intermittently fail JSON decoding on basic
    // commands. Allow local daemon retries to keep flowing and rely on
    // reducer idempotency for duplicate tolerance.
    return { claimed: true };
  }

  const claimKey = getDaemonProcessingEventClaimKey({
    loopId,
    eventId: envelope.eventId,
  });
  const committedKey = getDaemonProcessingEventCommittedKey({
    loopId,
    eventId: envelope.eventId,
  });

  try {
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
  } catch (error) {
    if (isLocalRedisHttpMode() && isRedisTransportParseError(error)) {
      console.warn(
        "[daemon-event] local redis claim parse failure, bypassing claim",
        {
          loopId,
          eventId: envelope.eventId,
        },
      );
      return { claimed: true };
    }
    throw error;
  }
}

async function commitEnrolledLoopProcessingEvent({
  loopId,
  envelope,
}: {
  loopId: string;
  envelope: DaemonEventEnvelopeV2;
}): Promise<void> {
  if (isLocalRedisHttpMode()) {
    return;
  }

  const claimKey = getDaemonProcessingEventClaimKey({
    loopId,
    eventId: envelope.eventId,
  });
  const committedKey = getDaemonProcessingEventCommittedKey({
    loopId,
    eventId: envelope.eventId,
  });
  try {
    const pipeline = redis.pipeline();
    pipeline.set(committedKey, new Date().toISOString(), {
      ex: DAEMON_PROCESSING_EVENT_COMMITTED_TTL_SECONDS,
    });
    pipeline.del(claimKey);
    await pipeline.exec();
  } catch (error) {
    if (isLocalRedisHttpMode() && isRedisTransportParseError(error)) {
      console.warn(
        "[daemon-event] local redis commit parse failure, skipping commit",
        {
          loopId,
          eventId: envelope.eventId,
        },
      );
      return;
    }
    throw error;
  }
}

async function rollbackEnrolledLoopProcessingEventClaim({
  loopId,
  envelope,
}: {
  loopId: string;
  envelope: DaemonEventEnvelopeV2;
}): Promise<void> {
  if (isLocalRedisHttpMode()) {
    return;
  }

  const claimKey = getDaemonProcessingEventClaimKey({
    loopId,
    eventId: envelope.eventId,
  });
  try {
    await redis.del(claimKey);
  } catch (error) {
    if (isLocalRedisHttpMode() && isRedisTransportParseError(error)) {
      console.warn(
        "[daemon-event] local redis rollback parse failure, skipping rollback",
        {
          loopId,
          eventId: envelope.eventId,
        },
      );
      return;
    }
    throw error;
  }
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

function buildCompletedEvent(
  state: string | undefined,
  runId: string,
  runSeq: number | null,
  headSha: string | null | undefined,
) {
  switch (state) {
    case "planning":
      return runSeq == null
        ? { type: "planning_run_completed" as const }
        : { type: "planning_run_completed" as const, runId, runSeq };
    case "gating_review":
      return { type: "gate_review_passed" as const, runId, runSeq, headSha };
    case "gating_ci":
      return { type: "gate_ci_passed" as const, runId, runSeq, headSha };
    default:
      return { type: "run_completed" as const, runId, runSeq, headSha };
  }
}

function buildFailedEvent(
  state: string | undefined,
  runId: string,
  runSeq: number | null,
  headSha: string | null | undefined,
  errorMessage: string | undefined,
  errorCategory: string | null,
) {
  switch (state) {
    case "planning":
      // Daemon-reported failures during planning are process crashes (e.g.
      // Codex app-server died from bad skill YAML), NOT plan-artifact parse
      // failures.  Emit run_failed so the reducer routes through
      // classifyFailureLane → retryInPlanning with proper lane/budget logic.
      // plan_failed is reserved for the effect system (process-effects.ts)
      // when a plan artifact itself cannot be parsed.
      return {
        type: "run_failed" as const,
        runId,
        runSeq,
        message: errorMessage ?? "Planning run failed",
        category: errorCategory,
      };
    case "gating_review":
      return {
        type: "gate_review_failed" as const,
        runId,
        runSeq,
        reason: errorMessage ?? "Gate blocked",
      };
    case "gating_ci":
      return {
        type: "gate_ci_failed" as const,
        runId,
        runSeq,
        headSha,
        reason: errorMessage ?? "CI gate blocked",
      };
    default:
      return {
        type: "run_failed" as const,
        runId,
        runSeq,
        message: errorMessage ?? "Run failed",
        category: errorCategory,
      };
  }
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

function getDaemonTestAuthContextOrNull(
  request: Pick<Request, "headers">,
): DaemonTokenAuthContext | null {
  if (process.env.NODE_ENV === "production") {
    return null;
  }

  if (request.headers.get("X-Daemon-Token")) {
    return null;
  }

  if (
    request.headers.get(DAEMON_TEST_AUTH_HEADER) !==
    DAEMON_TEST_AUTH_ENABLED_VALUE
  ) {
    return null;
  }

  if (request.headers.get("X-Terragon-Secret") !== env.INTERNAL_SHARED_SECRET) {
    return null;
  }

  const userId = request.headers.get(DAEMON_TEST_USER_ID_HEADER);
  if (!userId || userId.length === 0) {
    return null;
  }

  return {
    userId,
    keyId: null,
    claims: null,
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
  const daemonHeadShaAtCompletion =
    typeof json.headShaAtCompletion === "string" &&
    json.headShaAtCompletion.length > 0
      ? json.headShaAtCompletion
      : null;
  const rawThreadChatId = json.threadChatId;
  const threadChatId =
    typeof rawThreadChatId === "string" && rawThreadChatId.length > 0
      ? rawThreadChatId
      : LEGACY_THREAD_CHAT_ID;
  const envelopeV2 = getDaemonEventEnvelopeV2(json);
  let selfDispatchPayload: SdlcSelfDispatchPayload | null = null;
  const daemonTokenAuthContext = await getDaemonTokenAuthContextOrNull(request);
  const daemonTestAuthContext = daemonTokenAuthContext
    ? null
    : getDaemonTestAuthContextOrNull(request);
  const daemonAuthContext = daemonTokenAuthContext ?? daemonTestAuthContext;
  const usingDaemonTestAuth = daemonTestAuthContext !== null;
  if (!daemonAuthContext) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = daemonAuthContext.userId;
  const claims = daemonAuthContext.claims;

  const deltas = json.deltas;
  const dbPreflight = await getDaemonEventDbPreflight(db);
  const canPersistTokenStreamEvents = dbPreflight.tokenStreamEventReady;
  const canPersistRunContextFailureMeta =
    dbPreflight.agentRunContextFailureColumnsReady;

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

  const updateRunContextIfPresent = async (
    updates: Parameters<typeof updateAgentRunContext>[0]["updates"],
  ): Promise<void> => {
    if (!runContext) {
      return;
    }

    const touchesFailureMetadata =
      "failureCategory" in updates ||
      "failureSource" in updates ||
      "failureRetryable" in updates ||
      "failureSignatureHash" in updates ||
      "failureTerminalReason" in updates;
    if (touchesFailureMetadata && !canPersistRunContextFailureMeta) {
      return;
    }

    await updateAgentRunContext({
      db,
      userId,
      runId: runContext.runId,
      updates,
    });
  };

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
    if (!usingDaemonTestAuth) {
      return Response.json(
        {
          success: false,
          error: "daemon_token_claims_required",
          runId: envelopeV2.runId,
        },
        { status: 401 },
      );
    }
    if (!runContext) {
      return Response.json(
        {
          success: false,
          error: "daemon_event_run_context_not_found",
          runId: envelopeV2.runId,
        },
        { status: 409 },
      );
    }
    if (
      runContext.threadId !== threadId ||
      runContext.threadChatId !== threadChatId
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
        threadChatId !== LEGACY_THREAD_CHAT_ID
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
            acknowledgedEventId: envelopeV2.eventId,
            acknowledgedSeq: envelopeV2.seq,
          },
          replayedSelfDispatch,
        ),
      );
    }
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

  if (deltas && deltas.length > 0) {
    const deltaRunId =
      envelopeV2?.runId ?? daemonAuthContext.claims?.runId ?? "legacy";
    const normalizedDeltas = normalizeDeltasForPersistence(deltas);
    const knownMaxSeqByKey = await getKnownMaxDeltaSeqByKey({
      runId: deltaRunId,
      deltas: normalizedDeltas,
    });
    const acceptedDeltas = filterDeltasByKnownMaxSeq({
      deltas: normalizedDeltas,
      runId: deltaRunId,
      maxSeqByKey: knownMaxSeqByKey,
    });

    if (acceptedDeltas.length > 0) {
      await persistKnownMaxDeltaSeqByKey({
        runId: deltaRunId,
        deltas: acceptedDeltas,
      });
    }

    if (acceptedDeltas.length > 0) {
      if (canPersistTokenStreamEvents) {
        try {
          const tokenEvents = await appendTokenStreamEvents({
            db,
            events: acceptedDeltas.map((delta, index) => ({
              userId,
              threadId,
              threadChatId,
              messageId: delta.messageId,
              partIndex: delta.partIndex,
              partType: delta.kind === "thinking" ? "thinking" : "text",
              text: delta.text,
              idempotencyKey:
                envelopeV2 !== null
                  ? `${threadChatId}:${envelopeV2.eventId}:${envelopeV2.seq}:${index}`
                  : `${threadChatId}:${deltaRunId}:delta:${delta.messageId}:${delta.partIndex}:${delta.deltaSeq}:${index}`,
            })),
          });

          const orderedTokenEvents = [...tokenEvents].sort(
            (a, b) => a.streamSeq - b.streamSeq,
          );
          for (const tokenEvent of orderedTokenEvents) {
            await publishDeltaBroadcast({
              userId,
              threadId,
              threadChatId,
              messageId: tokenEvent.messageId,
              partIndex: tokenEvent.partIndex,
              deltaSeq: tokenEvent.streamSeq,
              deltaIdempotencyKey: tokenEvent.idempotencyKey,
              deltaKind:
                tokenEvent.partType === "thinking" ? "thinking" : "text",
              text: tokenEvent.text,
            }).catch((error) => {
              console.warn("[daemon-event] delta broadcast failed", {
                threadId,
                threadChatId,
                messageId: tokenEvent.messageId,
                streamSeq: tokenEvent.streamSeq,
                error,
              });
            });
          }
        } catch (error) {
          if (!isMissingSchemaError(error)) {
            throw error;
          }
          console.error(
            "[daemon-event] token stream persistence unavailable, falling back to direct broadcast",
            {
              threadId,
              threadChatId,
              error,
            },
          );
          for (const [index, delta] of acceptedDeltas.entries()) {
            await publishDeltaBroadcast({
              userId,
              threadId,
              threadChatId,
              messageId: delta.messageId,
              partIndex: delta.partIndex,
              deltaSeq: delta.deltaSeq,
              deltaIdempotencyKey: `${threadChatId}:${deltaRunId}:fallback:${delta.messageId}:${delta.partIndex}:${delta.deltaSeq}:${index}`,
              deltaKind: delta.kind === "thinking" ? "thinking" : "text",
              text: delta.text,
            }).catch((broadcastError) => {
              console.warn("[daemon-event] fallback delta broadcast failed", {
                threadId,
                threadChatId,
                messageId: delta.messageId,
                deltaSeq: delta.deltaSeq,
                error: broadcastError,
              });
            });
          }
        }
      } else {
        for (const [index, delta] of acceptedDeltas.entries()) {
          await publishDeltaBroadcast({
            userId,
            threadId,
            threadChatId,
            messageId: delta.messageId,
            partIndex: delta.partIndex,
            deltaSeq: delta.deltaSeq,
            deltaIdempotencyKey: `${threadChatId}:${deltaRunId}:preflight-fallback:${delta.messageId}:${delta.partIndex}:${delta.deltaSeq}:${index}`,
            deltaKind: delta.kind === "thinking" ? "thinking" : "text",
            text: delta.text,
          }).catch((error) => {
            console.warn(
              "[daemon-event] preflight fallback delta broadcast failed",
              {
                threadId,
                threadChatId,
                messageId: delta.messageId,
                deltaSeq: delta.deltaSeq,
                error,
              },
            );
          });
        }
      }
    }
  }

  // Heartbeat shortcut: empty messages skip delivery loop, envelope validation, and
  // run-context status transitions — just extend sandbox life + refresh updatedAt.
  if (messages.length === 0 && (!deltas || deltas.length === 0)) {
    const result = await handleDaemonEvent({
      messages: [],
      threadId,
      threadChatId,
      userId,
      timezone,
      contextUsage: null,
      runContext,
    });
    if (!result.success) {
      return new Response(result.error, { status: result.status || 500 });
    }
    return Response.json({ success: true });
  }

  const daemonRunStatusFromMessages = deriveRunStatusFromMessages(messages);
  const daemonTerminalErrorInfo = deriveDaemonTerminalErrorInfo(messages);

  const activeWorkflow = await getActiveWorkflowForThread({ db, threadId });
  const effectiveLoopId =
    runContext?.workflowId ?? activeWorkflow?.workflow.id ?? null;

  // Acknowledge dispatch intent once the run context is still in a
  // dispatch-pending state. Envelope v2 starts at seq=0, so this stays
  // status-based (idempotent), not seq-based. The workflow reducer no longer
  // depends on ack/start events for progression; terminal signals remain
  // authoritative when fenced by runSeq.
  if (
    effectiveLoopId &&
    envelopeV2 &&
    runContext &&
    (runContext.status === "pending" || runContext.status === "dispatched")
  ) {
    try {
      await handleAckReceived({
        db,
        runId: envelopeV2.runId,
        loopId: effectiveLoopId!,
        threadChatId,
      });
    } catch (ackError) {
      console.warn("[delivery-loop] dispatch intent ack failed, non-blocking", {
        loopId: effectiveLoopId!,
        threadId,
        threadChatId,
        runId: envelopeV2.runId,
        error: ackError,
      });
    }
  }

  let claimedProcessingEvent = false;

  if (effectiveLoopId) {
    if (!envelopeV2) {
      console.error(
        "[delivery-loop] rejecting daemon event for enrolled loop without v2 envelope",
        {
          userId,
          threadId,
          loopId: effectiveLoopId!,
          daemonVersionHeader,
          daemonCapabilitiesHeader,
          payloadVersion: json.payloadVersion ?? null,
        },
      );
      return Response.json(
        {
          success: false,
          error: "enrolled_loop_requires_v2_envelope",
          loopId: effectiveLoopId!,
        },
        { status: 409 },
      );
    }

    if (envelopeV2 && daemonRunStatusFromMessages === "processing") {
      const processingClaimResult = await claimEnrolledLoopProcessingEvent({
        loopId: effectiveLoopId!,
        envelope: envelopeV2,
      });
      if (!processingClaimResult.claimed) {
        if (processingClaimResult.reason === "claim_in_progress") {
          return Response.json(
            {
              success: false,
              error: "daemon_event_claim_in_progress",
              loopId: effectiveLoopId!,
            },
            { status: 409 },
          );
        }
        return Response.json(
          {
            success: true,
            deduplicated: true,
            reason: processingClaimResult.reason,
            loopId: effectiveLoopId!,
            acknowledgedEventId: envelopeV2.eventId,
            acknowledgedSeq: envelopeV2.seq,
          },
          { status: 202 },
        );
      }
      claimedProcessingEvent = true;
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
    await updateRunContextIfPresent({
      status: "processing",
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
      runContext,
      workflowId: effectiveLoopId,
    });
  } catch (error) {
    console.error(
      "[daemon-event] UNHANDLED ERROR in main processing — FULL ERROR:",
      error,
    );
    if (runContext) {
      await updateRunContextIfPresent({
        status: "failed",
      });
    }
    if (effectiveLoopId && envelopeV2 && claimedProcessingEvent) {
      await rollbackEnrolledLoopProcessingEventClaim({
        loopId: effectiveLoopId!,
        envelope: envelopeV2,
      });
    }
    throw error;
  }

  if (!result.success) {
    if (runContext) {
      await updateRunContextIfPresent({
        status: "failed",
      });
    }
    if (effectiveLoopId && envelopeV2 && claimedProcessingEvent) {
      await rollbackEnrolledLoopProcessingEventClaim({
        loopId: effectiveLoopId!,
        envelope: envelopeV2,
      });
    }
    return new Response(result.error, { status: result.status || 500 });
  }

  const resolvedSessionId = deriveSessionIdFromMessages(messages);
  const resolvedStatus = daemonRunStatusFromMessages;

  // Processing event commit and run context update are independent — batch them.
  // Best-effort: if these fail, the signal claim commit and coordinator tick
  // must still proceed. A failure here previously stranded the claim in
  // "claimed" state until stale-claim timeout, blocking daemon retries.
  {
    const postHandleOps: Array<Promise<unknown>> = [];
    if (effectiveLoopId && envelopeV2 && claimedProcessingEvent) {
      postHandleOps.push(
        commitEnrolledLoopProcessingEvent({
          loopId: effectiveLoopId!,
          envelope: envelopeV2,
        }),
      );
    }
    if (runContext) {
      // Only update resolvedSessionId here. Terminal status (completed/
      // failed/stopped) is deferred until after the coordinator tick
      // succeeds — if the tick fails and we return 500, the run must
      // stay non-terminal so the daemon retry re-enters the main path.
      postHandleOps.push(
        updateRunContextIfPresent({
          resolvedSessionId,
          ...(resolvedStatus === "processing"
            ? { status: "processing" as const }
            : {}),
        }),
      );
    }
    if (postHandleOps.length > 0) {
      try {
        await Promise.all(postHandleOps);
      } catch (postHandleErr) {
        // Non-fatal — processing event commit and resolvedSessionId are
        // bookkeeping, not critical path. Log and continue to claim commit
        // + coordinator tick so the daemon retry doesn't hit stale claim.
        console.warn(
          "[daemon-event] postHandleOps best-effort failure, continuing",
          {
            userId,
            threadId,
            error: postHandleErr,
          },
        );
      }
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

  // V3 kernel bridge: mirror terminal daemon outcomes into the
  // Postgres-canonical journal/effect-ledger runtime.
  if (
    effectiveLoopId &&
    envelopeV2 &&
    daemonRunStatusFromMessages !== "processing"
  ) {
    try {
      const headAtTerminal = await getWorkflowHead({
        db,
        workflowId: effectiveLoopId,
      });
      const terminalState = headAtTerminal?.state;
      const terminalRunSeq =
        runContext?.runSeq ??
        (headAtTerminal?.activeRunId === null ||
        headAtTerminal?.activeRunId === envelopeV2.runId
          ? (headAtTerminal?.activeRunSeq ?? null)
          : null);
      if (terminalRunSeq == null) {
        // Migration-window fallback: keep bridging terminal events even when
        // older run-context rows lack runSeq or the active head cannot be
        // correlated to this run. Fencing by runSeq is still used whenever
        // available.
        console.warn(
          "[daemon-event] bridging terminal event without persisted runSeq (legacy fallback)",
          {
            loopId: effectiveLoopId,
            runId: envelopeV2.runId,
            state: terminalState,
          },
        );
      }

      if (daemonRunStatusFromMessages === "stopped") {
        // Preserve prior behavior: stopped terminals do not advance the v3 loop.
      } else if (daemonRunStatusFromMessages === "completed") {
        await appendEventAndAdvanceExplicit({
          db,
          workflowId: effectiveLoopId,
          source: "daemon",
          idempotencyKey:
            terminalState === "planning" && terminalRunSeq == null
              ? `planning-terminal:${envelopeV2.eventId}`
              : `run-completed:${envelopeV2.eventId}`,
          event: buildCompletedEvent(
            terminalState,
            envelopeV2.runId,
            terminalRunSeq,
            daemonHeadShaAtCompletion,
          ),
          behavior: {
            applyGateBypass: false,
            drainEffects: true,
          },
        });
      } else if (daemonRunStatusFromMessages === "failed") {
        await appendEventAndAdvanceExplicit({
          db,
          workflowId: effectiveLoopId,
          source: "daemon",
          idempotencyKey:
            terminalState === "planning" && terminalRunSeq == null
              ? `planning-terminal:${envelopeV2.eventId}`
              : `run-failed:${envelopeV2.eventId}`,
          event: buildFailedEvent(
            terminalState,
            envelopeV2.runId,
            terminalRunSeq,
            daemonHeadShaAtCompletion,
            daemonTerminalErrorInfo.errorMessage ?? undefined,
            daemonTerminalErrorInfo.errorCategory,
          ),
          behavior: {
            applyGateBypass: false,
            drainEffects: true,
          },
        });
      }
    } catch (v3Err) {
      console.error("[daemon-event] v3 kernel bridge failed, continuing", {
        loopId: effectiveLoopId,
        runId: envelopeV2?.runId,
        error: v3Err,
      });
    }

    // NOTE: kernel advance is configured for eager effect drain in this path.
    // The cron at /api/internal/cron/dispatch-ack-timeout remains as safety net.
  }

  // Now that the coordinator tick succeeded, finalize the terminal run status.
  // This was deferred from the postHandleOps block so that a tick failure
  // keeps the run non-terminal and allows daemon retries to re-enter the
  // main processing path. Both writes are awaited to prevent silent drops.
  let didUpdateTerminalDispatchStatus = false;
  {
    const terminalOps: Array<Promise<unknown>> = [];
    if (runContext && resolvedStatus !== "processing") {
      terminalOps.push(updateRunContextIfPresent({ status: resolvedStatus }));
    }
    if (
      effectiveLoopId &&
      envelopeV2 &&
      daemonRunStatusFromMessages !== "processing"
    ) {
      terminalOps.push(
        persistDaemonTerminalDispatchStatus({
          loopId: effectiveLoopId!,
          threadChatId,
          runId: envelopeV2.runId,
          daemonRunStatus: daemonRunStatusFromMessages,
          daemonErrorMessage: daemonTerminalErrorInfo.errorMessage,
          daemonErrorCategory: daemonTerminalErrorInfo.errorCategory,
        }).then((result) => {
          didUpdateTerminalDispatchStatus = true;
          return result;
        }),
      );
    }
    if (terminalOps.length > 0) {
      const results = await Promise.allSettled(terminalOps);
      for (const r of results) {
        if (r.status === "rejected") {
          // Non-blocking: handleDaemonEvent already committed thread
          // side effects (messages, tool results). Returning 500 here
          // would cause the daemon to retry and duplicate those effects.
          // Terminal run-status staleness is acceptable — the cron sweep
          // and ack timeout will eventually reconcile.
          console.warn("[daemon-event] terminal state persistence failed", {
            runId: runContext?.runId ?? envelopeV2?.runId,
            enrolled: !!effectiveLoopId,
            error: r.reason,
          });
        }
      }
    }
  }

  // Broadcast delivery-loop refetch on terminal daemon events that materially
  // changed the delivery-loop state. This enables event-driven UI updates.
  if (
    didUpdateTerminalDispatchStatus &&
    effectiveLoopId &&
    envelopeV2 &&
    daemonRunStatusFromMessages !== "processing"
  ) {
    publishBroadcastUserMessage({
      type: "user",
      id: userId,
      data: {
        threadPatches: [
          {
            threadId,
            threadChatId,
            op: "refetch",
            refetch: ["delivery-loop"],
          },
        ],
      },
    }).catch((error) => {
      console.warn("[daemon-event] delivery-loop broadcast failed", {
        threadId,
        threadChatId,
        loopId: effectiveLoopId,
        error,
      });
    });
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

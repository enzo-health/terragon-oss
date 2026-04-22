import {
  getDaemonTokenAuthContextOrNull,
  type DaemonTokenAuthContext,
} from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import { publishBroadcastUserMessage } from "@terragon/shared/broadcast-server";
import {
  DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
  DAEMON_EVENT_CAPABILITIES_HEADER,
  DAEMON_EVENT_VERSION_HEADER,
  DaemonEventAPIBody,
  type SdlcSelfDispatchPayload,
} from "@terragon/daemon/shared";
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
import {
  assignThreadChatMessageSeqToCanonicalEvents,
  findOpenAgUiMessagesForRun,
} from "@terragon/shared/model/agent-event-log";
import {
  getThreadMinimal,
  getThreadChat,
  touchThreadChatUpdatedAt,
  updateThreadChatTerminalMetadataIfTerminal,
} from "@terragon/shared/model/threads";
import { extendSandboxLife } from "@terragon/sandbox";
import { waitUntil } from "@vercel/functions";
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
  broadcastAgUiEventEphemeral,
  buildDeltaRunEndRows,
  buildRunTerminalAgUi,
  canonicalEventsToAgUiRows,
  daemonDeltasToAgUiRows,
  dbAgentMessagePartsToAgUiRows,
  metaEventsToAgUiEvents,
  persistAndPublishAgUiEvents,
  type AssistantMessagePartsInput,
} from "@/server-lib/ag-ui-publisher";
import { toDBMessage } from "@/agent/msg/toDBMessage";
import { env } from "@terragon/env/apps-www";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { hashFailureMessage } from "@terragon/shared/delivery-loop/domain/failure-signature";
import {
  DELIVERY_LOOP_FAILURE_ACTION_TABLE,
  type DeliveryLoopFailureCategory,
} from "@terragon/shared/delivery-loop/domain/failure";

type DaemonEventEnvelopeV2 = {
  payloadVersion: 2;
  eventId: string;
  runId: string;
  seq: number;
};

const DAEMON_PROCESSING_EVENT_CLAIM_TTL_SECONDS = 60;
const DAEMON_PROCESSING_EVENT_COMMITTED_TTL_SECONDS = 60 * 60 * 24;
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

type CanonicalPersistenceSummary = {
  attempted: number;
  inserted: number;
  deduplicated: number;
  /**
   * eventIds of AG-UI rows that were freshly inserted for the incoming
   * canonical events (expanded 1→N). Used to backfill
   * `thread_chat_message_seq` after `handleDaemonEvent` returns a replay
   * sequence number — the route must NOT re-map via
   * `canonicalEventsToAgUiRows` because that would risk drift between
   * producer and consumer.
   */
  insertedEventIds: string[];
};

type CanonicalEventsPayload = NonNullable<
  DaemonEventAPIBody["canonicalEvents"]
>;

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

function findCanonicalEventContextMismatch(params: {
  canonicalEvents: CanonicalEventsPayload;
  runId: string;
  threadId: string;
  threadChatId: string;
}): { eventId: string; reason: "runId" | "threadId" | "threadChatId" } | null {
  for (const event of params.canonicalEvents) {
    if (event.runId !== params.runId) {
      return { eventId: event.eventId, reason: "runId" };
    }
    if (event.threadId !== params.threadId) {
      return { eventId: event.eventId, reason: "threadId" };
    }
    if (event.threadChatId !== params.threadChatId) {
      return { eventId: event.eventId, reason: "threadChatId" };
    }
  }

  return null;
}

async function persistCanonicalEventsOrResponse(params: {
  canonicalEvents: CanonicalEventsPayload | null;
  canPersistCanonicalEvents: boolean;
  runId: string;
  threadId: string;
  threadChatId: string;
}): Promise<
  | { summary: CanonicalPersistenceSummary; response?: undefined }
  | { summary?: undefined; response: Response }
> {
  const canonicalEvents = params.canonicalEvents;
  if (!canonicalEvents || canonicalEvents.length === 0) {
    return {
      summary: {
        attempted: 0,
        inserted: 0,
        deduplicated: 0,
        insertedEventIds: [],
      },
    };
  }

  if (!params.canPersistCanonicalEvents) {
    return {
      response: Response.json(
        {
          success: false,
          error: "daemon_event_canonical_persistence_unavailable",
        },
        { status: 503 },
      ),
    };
  }

  const contextMismatch = findCanonicalEventContextMismatch({
    canonicalEvents,
    runId: params.runId,
    threadId: params.threadId,
    threadChatId: params.threadChatId,
  });
  if (contextMismatch) {
    return {
      response: Response.json(
        {
          success: false,
          error: "daemon_event_canonical_event_context_mismatch",
          eventId: contextMismatch.eventId,
          reason: contextMismatch.reason,
        },
        { status: 409 },
      ),
    };
  }

  const rows = canonicalEventsToAgUiRows(canonicalEvents);
  try {
    const result = await persistAndPublishAgUiEvents({
      db,
      runId: params.runId,
      threadId: params.threadId,
      threadChatId: params.threadChatId,
      rows,
    });
    return {
      summary: {
        attempted: canonicalEvents.length,
        inserted: result.inserted,
        deduplicated: result.skipped,
        insertedEventIds: result.insertedEventIds,
      },
    };
  } catch (error) {
    console.error("[daemon-event] AG-UI canonical persistence failed", {
      runId: params.runId,
      threadId: params.threadId,
      threadChatId: params.threadChatId,
      error,
    });
    return {
      response: Response.json(
        {
          success: false,
          error: "daemon_event_canonical_event_persist_failed",
          code: "database_error",
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
    };
  }
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

function findCanonicalRunTerminalEvent(
  canonicalEvents: CanonicalEventsPayload,
): {
  status: "completed" | "failed" | "stopped";
  errorMessage: string | null;
  errorCode: string | null;
  headShaAtCompletion: string | null;
} | null {
  for (const event of canonicalEvents) {
    if (event.category !== "operational") continue;
    if (event.type !== "run-terminal") continue;
    return {
      status: event.status,
      errorMessage: event.errorMessage ?? null,
      errorCode: event.errorCode ?? null,
      headShaAtCompletion: event.headShaAtCompletion ?? null,
    };
  }
  return null;
}

function deriveTerminalFailureSource(
  messages: DaemonEventAPIBody["messages"],
): "custom-error" | "result" | "custom-stop" | "unknown" | null {
  for (const message of messages) {
    if (message.type === "custom-error") return "custom-error";
    if (message.type === "custom-stop") return "custom-stop";
    if (message.type === "result" && message.is_error) return "result";
  }
  return null;
}

function isFailureRetryable(
  failureCategory: DeliveryLoopFailureCategory,
): boolean {
  const action =
    DELIVERY_LOOP_FAILURE_ACTION_TABLE[
      failureCategory as keyof typeof DELIVERY_LOOP_FAILURE_ACTION_TABLE
    ];
  return action !== "blocked";
}

function buildRunContextFailureUpdates(params: {
  status: "processing" | "completed" | "failed" | "stopped";
  errorMessage: string | null;
  errorCategory: DaemonTerminalErrorCategory;
  failureSource: "custom-error" | "result" | "custom-stop" | "unknown" | null;
}):
  | {
      failureCategory: DeliveryLoopFailureCategory | null;
      failureSource:
        | "custom-error"
        | "result"
        | "custom-stop"
        | "unknown"
        | null;
      failureRetryable: boolean | null;
      failureSignatureHash: number | null;
      failureTerminalReason: string | null;
    }
  | {} {
  if (params.status !== "failed") {
    return {
      failureCategory: null,
      failureSource: null,
      failureRetryable: null,
      failureSignatureHash: null,
      failureTerminalReason: null,
    };
  }
  const failureCategory = mapDaemonTerminalCategoryToFailureCategory(
    params.errorCategory,
    params.errorMessage,
  );
  const signatureSource = params.errorMessage;
  return {
    failureCategory,
    failureSource: params.failureSource,
    failureRetryable: isFailureRetryable(failureCategory),
    failureSignatureHash:
      signatureSource != null ? hashFailureMessage(signatureSource) : null,
    failureTerminalReason: params.errorMessage,
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

/**
 * Returns true if any message in the batch contains at least one tool_use
 * content block (i.e. the agent invoked at least one tool during this run).
 * Used by the no-progress guard in the v3 delivery-loop reducer.
 */
/**
 * Returns `true` if any tool usage is OBSERVED in this POST's messages. Returns
 * `undefined` when no tool usage is found — IMPORTANT: do NOT return `false`,
 * because tool calls are commonly emitted in earlier flushes of the same run
 * while the terminal `result` flush carries no tool blocks. The narration-only
 * escalation reducer treats `undefined` as "had tool calls" (safe default), so
 * a `false` here would falsely increment the escalation counter for runs that
 * actually used tools but spread their messages across multiple POSTs.
 *
 * If we ever need authoritative per-run accounting, the daemon should send an
 * explicit `hasToolCallsAtCompletion` field computed across the whole run.
 */
function hasToolCallsInMessages(
  messages: DaemonEventAPIBody["messages"],
): true | undefined {
  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block !== null &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "tool_use"
      ) {
        return true;
      }
    }
  }
  return undefined;
}

function buildCompletedEvent(
  state: string | undefined,
  runId: string,
  runSeq: number | null,
  headSha: string | null | undefined,
  hasToolCalls?: boolean,
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
      return {
        type: "run_completed" as const,
        runId,
        runSeq,
        headSha,
        hasToolCalls,
      };
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

function hasValidThreadChatId(threadChatId: unknown): threadChatId is string {
  return (
    typeof threadChatId === "string" &&
    threadChatId.length > 0 &&
    threadChatId !== "legacy-thread-chat-id"
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
  if (!hasValidThreadChatId(rawThreadChatId)) {
    return Response.json(
      {
        success: false,
        error: "daemon_event_non_legacy_requires_thread_chat_id",
      },
      { status: 400 },
    );
  }
  const threadChatId = rawThreadChatId;
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

  const canonicalEvents = Array.isArray(json.canonicalEvents)
    ? json.canonicalEvents
    : null;
  const deltas = json.deltas;

  // Meta events (token usage, rate limits, model re-routing, MCP health,
  // config warnings) are fire-and-forget operational signals. They don't
  // need DB persistence — the chip UI displays only the current value.
  // Publish as AG-UI CUSTOM events on the thread-chat stream so the chat
  // UI receives them via the SSE subscription.
  const metaEvents = Array.isArray(json.metaEvents) ? json.metaEvents : null;
  if (metaEvents && metaEvents.length > 0) {
    for (const agUi of metaEventsToAgUiEvents(metaEvents)) {
      broadcastAgUiEventEphemeral({ threadChatId, event: agUi }).catch(
        (error) => {
          console.warn("[daemon-event] meta-event AG-UI broadcast failed", {
            threadId,
            threadChatId,
            error,
          });
        },
      );
    }
  }

  const dbPreflight = await getDaemonEventDbPreflight(db);
  const canPersistCanonicalEvents = dbPreflight.agentEventLogReady;
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

  let runContext: Awaited<ReturnType<typeof getAgentRunContextByRunId>> | null =
    null;
  const authoritativeRunId = claims?.runId ?? envelopeV2?.runId ?? null;
  if (!authoritativeRunId) {
    return Response.json(
      {
        success: false,
        error: "daemon_event_run_id_required",
      },
      { status: 400 },
    );
  }
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
  }

  const canonicalPersistence = await persistCanonicalEventsOrResponse({
    canonicalEvents,
    canPersistCanonicalEvents,
    runId: runContext.runId,
    threadId,
    threadChatId,
  });
  if (canonicalPersistence.response) {
    return canonicalPersistence.response;
  }

  const shouldIgnoreTerminalRun =
    runContext !== null &&
    (claims !== null || (usingDaemonTestAuth && envelopeV2 !== null)) &&
    (runContext.status === "completed" ||
      runContext.status === "failed" ||
      runContext.status === "stopped");
  if (shouldIgnoreTerminalRun) {
    const replayedSelfDispatch = envelopeV2
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

  // Daemon deltas → AG-UI TEXT_MESSAGE_CONTENT / REASONING_MESSAGE_CONTENT
  // rows. Persisted to agent_event_log with per-thread-chat seq and
  // XADD'd to the live-tail stream. The legacy token_stream_event table
  // and the deltaSeq broadcast patch are gone — AG-UI replay via
  // /api/ag-ui/[threadId] covers both live tail and reconnection catch-up.
  if (deltas && deltas.length > 0) {
    if (!canPersistCanonicalEvents) {
      return Response.json(
        {
          success: false,
          error: "daemon_event_canonical_persistence_unavailable",
        },
        { status: 503 },
      );
    }
    try {
      await persistAndPublishAgUiEvents({
        db,
        runId: authoritativeRunId,
        threadId,
        threadChatId,
        rows: daemonDeltasToAgUiRows({
          runId: authoritativeRunId,
          deltas,
        }),
      });
    } catch (error) {
      console.error("[daemon-event] AG-UI delta persistence failed", {
        threadId,
        threadChatId,
        runId: authoritativeRunId,
        error,
      });
      return Response.json(
        {
          success: false,
          error: "daemon_event_canonical_event_persist_failed",
          code: "database_error",
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  }

  // Heartbeat shortcut: empty messages skip delivery loop, envelope validation, and
  // run-context status transitions — just extend sandbox life + refresh updatedAt.
  if (
    messages.length === 0 &&
    (!deltas || deltas.length === 0) &&
    (!canonicalEvents || canonicalEvents.length === 0)
  ) {
    const result = await handleDaemonEvent({
      messages: [],
      threadId,
      threadChatId,
      userId,
      timezone,
      contextUsage: null,
      runId: authoritativeRunId,
      runContext,
    });
    if (!result.success) {
      return new Response(result.error, { status: result.status || 500 });
    }
    return Response.json({ success: true });
  }

  if (
    messages.length === 0 &&
    (!deltas || deltas.length === 0) &&
    canonicalEvents &&
    canonicalEvents.length > 0
  ) {
    const canonicalTerminal = findCanonicalRunTerminalEvent(canonicalEvents);
    if (canonicalTerminal) {
      // Canonical-only terminal batches must not take the freshness-touch
      // shortcut; they need the fenced terminal transition contract below.
    } else {
      waitUntil(
        (async () => {
          try {
            await touchThreadChatUpdatedAt({ db, threadId, threadChatId });
          } catch (error) {
            console.warn(
              "[daemon-event] canonical-only freshness touch failed",
              {
                threadId,
                threadChatId,
                error,
              },
            );
          }
        })(),
      );
      waitUntil(
        (async () => {
          try {
            const thread = await getThreadMinimal({ db, threadId, userId });
            if (thread?.codesandboxId && thread.sandboxProvider) {
              await extendSandboxLife({
                sandboxId: thread.codesandboxId,
                sandboxProvider: thread.sandboxProvider,
              });
            }
          } catch (error) {
            console.warn(
              "[daemon-event] canonical-only thread refresh failed",
              {
                threadId,
                threadChatId,
                error,
              },
            );
          }
        })(),
      );
      return Response.json({
        success: true,
        canonicalEventsPersisted: canonicalPersistence.summary.inserted,
        canonicalEventsDeduplicated: canonicalPersistence.summary.deduplicated,
      });
    }
  }

  const canonicalTerminal = canonicalEvents
    ? findCanonicalRunTerminalEvent(canonicalEvents)
    : null;
  const daemonRunStatusFromMessages = canonicalTerminal
    ? canonicalTerminal.status
    : deriveRunStatusFromMessages(messages);
  const daemonTerminalErrorInfo = canonicalTerminal
    ? {
        errorMessage: canonicalTerminal.errorMessage,
        errorCategory: canonicalTerminal.errorMessage
          ? classifyDaemonTerminalErrorCategory(canonicalTerminal.errorMessage)
          : "unknown",
      }
    : deriveDaemonTerminalErrorInfo(messages);
  const terminalFailureSource = canonicalTerminal
    ? daemonRunStatusFromMessages === "stopped"
      ? ("custom-stop" as const)
      : daemonRunStatusFromMessages === "failed"
        ? ("custom-error" as const)
        : null
    : deriveTerminalFailureSource(messages);
  const effectiveHeadShaAtCompletion =
    daemonHeadShaAtCompletion ?? canonicalTerminal?.headShaAtCompletion ?? null;

  const activeWorkflow = await getActiveWorkflowForThread({ db, threadId });
  const effectiveLoopId =
    runContext?.workflowId ?? activeWorkflow?.workflow.id ?? null;
  // Terminal transitions must be fenced across status surfaces even when a run
  // isn't enrolled in a delivery-loop workflow (workflowId can be null).
  // We still require an envelope v2 so the daemon can safely retry on fail-closed.
  const fenceTerminalTransition =
    daemonRunStatusFromMessages !== "processing" && envelopeV2 != null;

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
    const isCanonicalOnlyTerminalBatch =
      canonicalTerminal != null &&
      messages.length === 0 &&
      (!deltas || deltas.length === 0);
    result = isCanonicalOnlyTerminalBatch
      ? { success: true, threadChatMessageSeq: null }
      : await handleDaemonEvent({
          messages,
          threadId,
          threadChatId,
          userId,
          timezone,
          contextUsage: computedContextUsage ?? null,
          runId: authoritativeRunId,
          runContext,
          workflowId: effectiveLoopId,
          deferTerminalTransitionToRoute: fenceTerminalTransition,
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

  if (result.threadChatMessageSeq != null) {
    const insertedEventIds = canonicalPersistence.summary.insertedEventIds;
    if (insertedEventIds.length > 0) {
      // The persist layer already recorded the exact eventIds it wrote —
      // use them directly instead of re-running the mapper (which would
      // risk drift between producer and consumer if the mapping ever
      // changed). Duplicates from earlier POSTs already carry their seq
      // from the initial insert, so they're intentionally excluded here.
      await assignThreadChatMessageSeqToCanonicalEvents({
        db,
        eventIds: insertedEventIds,
        threadChatMessageSeq: result.threadChatMessageSeq,
      });
    }
  }

  // Emit AG-UI events for rich DBAgentMessage parts that are NOT covered by
  // the canonical-events pipeline (thinking, terminal, diff, image, audio,
  // pdf, text-file, resource-link, auto-approval-review, plan,
  // plan-structured, server-tool-use, web-search-result, rich-text). We
  // rebuild the DBMessages here rather than threading them back from
  // `handleDaemonEvent` — `toDBMessage` is pure, so the second call is
  // deterministic, and the stable (envelope eventId + messageIndex)
  // messageId pattern means retried POSTs dedupe on (runId, eventId).
  if (canPersistCanonicalEvents && envelopeV2) {
    const richPartInputs: AssistantMessagePartsInput[] = [];
    let messageIndex = 0;
    for (const claudeMessage of messages) {
      for (const dbMsg of toDBMessage(claudeMessage)) {
        const currentIndex = messageIndex++;
        if (dbMsg.type !== "agent") continue;
        // DBAgentMessage parts never contain tool-use/tool-result — those
        // are separate top-level DBMessage variants. The mapper's skip set
        // is a superset; here we only need to filter out pure-text parts.
        const hasRichParts = dbMsg.parts.some((part) => part.type !== "text");
        if (!hasRichParts) continue;
        richPartInputs.push({
          messageId: `${envelopeV2.eventId}:msg:${currentIndex}`,
          parts: dbMsg.parts,
        });
      }
    }
    if (richPartInputs.length > 0) {
      try {
        await persistAndPublishAgUiEvents({
          db,
          runId: authoritativeRunId,
          threadId,
          threadChatId,
          rows: dbAgentMessagePartsToAgUiRows(richPartInputs),
        });
      } catch (error) {
        // Rich-part emission is best-effort: the DBMessages themselves are
        // already committed via handleDaemonEvent, and the frontend
        // fallback-reads from thread chat if the AG-UI stream misses
        // something. Log and continue rather than 500 (which would force
        // the daemon to retry the whole POST and duplicate side effects).
        console.warn("[daemon-event] AG-UI rich-part persistence failed", {
          threadId,
          threadChatId,
          runId: authoritativeRunId,
          error,
        });
      }
    }
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
        await appendEventAndAdvanceExplicit({
          db,
          workflowId: effectiveLoopId,
          source: "daemon",
          idempotencyKey: `run-stopped:${envelopeV2.eventId}`,
          event: { type: "stop_requested" },
          behavior: {
            applyGateBypass: false,
            drainEffects: true,
          },
        });
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
            effectiveHeadShaAtCompletion,
            hasToolCallsInMessages(messages),
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
            effectiveHeadShaAtCompletion,
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
      if (fenceTerminalTransition) {
        console.error("[daemon-event] v3 kernel bridge failed (fenced)", {
          loopId: effectiveLoopId,
          runId: envelopeV2?.runId,
          error: v3Err,
        });
        return Response.json(
          {
            success: false,
            error: "daemon_event_terminal_v3_bridge_failed",
            loopId: effectiveLoopId,
            runId: envelopeV2?.runId ?? null,
            detail: v3Err instanceof Error ? v3Err.message : String(v3Err),
          },
          { status: 503 },
        );
      } else {
        console.error("[daemon-event] v3 kernel bridge failed, continuing", {
          loopId: effectiveLoopId,
          runId: envelopeV2?.runId,
          error: v3Err,
        });
      }
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

    if (fenceTerminalTransition) {
      const eventType =
        resolvedStatus === "stopped"
          ? ("assistant.message_stop" as const)
          : resolvedStatus === "failed"
            ? ("assistant.message_error" as const)
            : ("assistant.message_done" as const);

      const transitionResult = await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType,
        // `handleDaemonEvent` skips unread + terminal metadata when it defers the
        // terminal transition to this fenced route path.
        markAsUnread: true,
        // No chatUpdates here: this path is terminal-only and must not append
        // messages. Terminal metadata is written in a separate, status-gated
        // update below.
        requireStatusTransitionForChatUpdates: true,
        skipBroadcast: true,
      });

      if (transitionResult.updatedStatus && !transitionResult.didUpdateStatus) {
        const latest = await getThreadChat({
          db,
          userId,
          threadId,
          threadChatId,
        });
        if (!latest || latest.status !== transitionResult.updatedStatus) {
          return Response.json(
            {
              success: false,
              error: "daemon_event_terminal_thread_chat_cas_failed",
              expectedStatus: transitionResult.updatedStatus,
              actualStatus: latest?.status ?? null,
            },
            { status: 409 },
          );
        }
      }

      if (resolvedStatus === "failed") {
        const errorMessageStr = daemonTerminalErrorInfo.errorMessage;
        const isPromptTooLong =
          !!errorMessageStr &&
          /context.?length.?exceeded|context.?window|ran out of room|exceeds the context window|max.*tokens.*exceeded/i.test(
            errorMessageStr,
          );
        await updateThreadChatTerminalMetadataIfTerminal({
          db,
          userId,
          threadId,
          threadChatId,
          updates: {
            errorMessage: isPromptTooLong
              ? "prompt-too-long"
              : "agent-generic-error",
            errorMessageInfo: isPromptTooLong ? null : (errorMessageStr ?? ""),
          },
        });
      } else {
        await updateThreadChatTerminalMetadataIfTerminal({
          db,
          userId,
          threadId,
          threadChatId,
          updates: {
            errorMessage: null,
            errorMessageInfo: null,
          },
        });
      }

      if (runContext && resolvedStatus !== "processing") {
        terminalOps.push(
          updateRunContextIfPresent({
            status: resolvedStatus,
            ...buildRunContextFailureUpdates({
              status: resolvedStatus,
              errorMessage: daemonTerminalErrorInfo.errorMessage,
              errorCategory: daemonTerminalErrorInfo.errorCategory,
              failureSource: terminalFailureSource,
            }),
          }),
        );
      }
      if (effectiveLoopId && envelopeV2) {
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
        try {
          await Promise.all(terminalOps);
        } catch (error) {
          console.warn(
            "[daemon-event] fenced terminal state persistence failed",
            {
              threadId,
              threadChatId,
              runId: runContext?.runId ?? envelopeV2?.runId,
              error,
            },
          );
          return Response.json(
            {
              success: false,
              error: "daemon_event_terminal_persistence_failed",
              runId: runContext?.runId ?? envelopeV2?.runId ?? null,
              detail: error instanceof Error ? error.message : String(error),
            },
            { status: 503 },
          );
        }
      }
    } else {
      if (runContext && resolvedStatus !== "processing") {
        terminalOps.push(
          updateRunContextIfPresent({
            status: resolvedStatus,
            ...buildRunContextFailureUpdates({
              status: resolvedStatus,
              errorMessage: daemonTerminalErrorInfo.errorMessage,
              errorCategory: daemonTerminalErrorInfo.errorCategory,
              failureSource: terminalFailureSource,
            }),
          }),
        );
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

  // Before the terminal marker, close any (messageId, kind) lifecycles that
  // the delta ingestion path opened for this run but never closed. Without
  // the synthetic ENDs the AG-UI event log is not protocol-compliant and the
  // client rejects follow-up CONTENT/END events on replay. Scoped to the
  // current run so we only touch rows this run wrote.
  if (
    canPersistCanonicalEvents &&
    daemonRunStatusFromMessages !== "processing"
  ) {
    try {
      const openMessages = await findOpenAgUiMessagesForRun({
        db,
        runId: authoritativeRunId,
      });
      if (openMessages.length > 0) {
        const endRows = buildDeltaRunEndRows({
          runId: authoritativeRunId,
          openMessages,
        });
        await persistAndPublishAgUiEvents({
          db,
          runId: authoritativeRunId,
          threadId,
          threadChatId,
          rows: endRows,
        });
      }
    } catch (error) {
      // Best-effort: END synthesis is a consistency guarantee, but the
      // surrounding terminal path (status persistence, run finish marker)
      // must not be blocked by a read/write failure here. The AG-UI replay
      // synthesis in the SSE route serves as a secondary safety net for any
      // rows that slip through.
      console.warn(
        "[daemon-event] AG-UI run-terminal END synthesis failed, continuing",
        {
          threadId,
          threadChatId,
          runId: authoritativeRunId,
          error,
        },
      );
    }
  }

  // Emit a terminal AG-UI marker (RUN_FINISHED or RUN_ERROR) on the thread
  // chat stream. Ephemeral: not persisted to agent_event_log — the status
  // of the run is already in delivery-loop head / agentRunContext.status.
  if (daemonRunStatusFromMessages !== "processing") {
    broadcastAgUiEventEphemeral({
      threadChatId,
      event: buildRunTerminalAgUi({
        threadId,
        runId: authoritativeRunId,
        daemonRunStatus: daemonRunStatusFromMessages,
        errorMessage: daemonTerminalErrorInfo.errorMessage,
        errorCode: daemonTerminalErrorInfo.errorCategory,
      }),
    }).catch((error) => {
      console.warn("[daemon-event] run-terminal AG-UI broadcast failed", {
        threadId,
        threadChatId,
        runId: authoritativeRunId,
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

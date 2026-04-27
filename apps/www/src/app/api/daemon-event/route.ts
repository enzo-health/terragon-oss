import {
  DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
  DAEMON_EVENT_CAPABILITIES_HEADER,
  DaemonEventAPIBody,
} from "@terragon/daemon/shared";
import { env } from "@terragon/env/apps-www";
import { extendSandboxLife } from "@terragon/sandbox";
import * as schema from "@terragon/shared/db/schema";
import {
  assignThreadChatMessageSeqToCanonicalEvents,
  findOpenAgUiMessagesForRun,
} from "@terragon/shared/model/agent-event-log";
import {
  completeAgentRunContextTerminal,
  getAgentRunContextByRunId,
  updateAgentRunContext,
} from "@terragon/shared/model/agent-run-context";
import {
  getThreadChat,
  getThreadMinimal,
  touchThreadChatUpdatedAt,
  updateThreadChatTerminalMetadataIfTerminal,
} from "@terragon/shared/model/threads";
import {
  classifyDaemonTerminalErrorCategory,
  type DaemonTerminalErrorCategory,
  hashRuntimeFailureMessage,
  mapDaemonTerminalCategoryToRuntimeFailureCategory,
  RUNTIME_FAILURE_ACTION_TABLE,
  type RuntimeFailureCategory,
} from "@terragon/shared/runtime/failure";
import { waitUntil } from "@vercel/functions";
import { and, eq } from "drizzle-orm";
import { toDBMessage } from "@/agent/msg/toDBMessage";
import {
  hasOtherActiveRuns,
  setActiveThreadChat,
} from "@/agent/sandbox-resource";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import {
  type DaemonTokenAuthContext,
  type DaemonTokenProvider,
  getDaemonTokenAuthContextOrNull,
  hasDaemonProviderScope,
} from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  type AssistantMessagePartsInput,
  broadcastAgUiEventEphemeral,
  buildDeltaRunEndRows,
  buildRunTerminalAgUi,
  canonicalEventsToAgUiRows,
  daemonDeltasToAgUiRows,
  dbAgentMessagePartsToAgUiRows,
  metaEventsToAgUiEvents,
  persistAgUiEvents,
  persistAndPublishAgUiEvents,
  publishPersistedAgUiEvents,
} from "@/server-lib/ag-ui-publisher";
import { getDaemonEventDbPreflight } from "@/server-lib/daemon-event-db-preflight";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";

type DaemonEventEnvelopeV2 = {
  payloadVersion: 2;
  eventId: string;
  runId: string;
  seq: number;
};

const DAEMON_TEST_AUTH_HEADER = "X-Terragon-Test-Daemon-Auth";
const DAEMON_TEST_USER_ID_HEADER = "X-Terragon-Test-User-Id";
const DAEMON_TEST_AUTH_ENABLED_VALUE = "enabled";

type TerminalAckBase = {
  status?: number;
  deduplicated?: true;
  reason?: string;
  loopId?: string;
  runId?: string;
  acknowledgedEventId: string | null;
  acknowledgedSeq: number | null;
};

type TerminalAckState = TerminalAckBase;

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
  persistedEvents: Parameters<
    typeof publishPersistedAgUiEvents
  >[0]["persistedEvents"];
};

type CanonicalEventsPayload = NonNullable<
  DaemonEventAPIBody["canonicalEvents"]
>;

type DaemonDeltasPayload = NonNullable<DaemonEventAPIBody["deltas"]>;

function filterCanonicalEventsForDeltaCoexistence(params: {
  canonicalEvents: CanonicalEventsPayload | null;
  deltas: DaemonDeltasPayload | null | undefined;
}): CanonicalEventsPayload | null {
  const { canonicalEvents, deltas } = params;
  if (!canonicalEvents || canonicalEvents.length === 0) {
    return canonicalEvents;
  }
  if (!deltas || deltas.length === 0) {
    return canonicalEvents;
  }

  // Daemon v2 can emit both:
  // 1) canonical assistant-message events (full text), and
  // 2) incremental deltas for the same turn.
  //
  // Replaying both produces duplicated assistant bubbles in the UI.
  // Keep streaming deltas as the source of truth for assistant text when
  // they are present, and persist only the non-assistant canonical events
  // (run-started, run-terminal, tool lifecycle, etc.).
  return canonicalEvents.filter((event) => event.type !== "assistant-message");
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
    },
    { status: state.status ?? 200 },
  );
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
}): {
  eventId: string;
  reason: "payloadVersion" | "runId" | "threadId" | "threadChatId";
} | null {
  for (const event of params.canonicalEvents) {
    if (event.payloadVersion !== 2) {
      return { eventId: event.eventId, reason: "payloadVersion" };
    }
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

function requiredDaemonProviderScopesForAgent(
  agent: NonNullable<
    Awaited<ReturnType<typeof getAgentRunContextByRunId>>
  >["agent"],
): DaemonTokenProvider[] {
  switch (agent) {
    case "claudeCode":
    case "amp":
      return ["anthropic"];
    case "codex":
      return ["openai"];
    case "gemini":
      return ["google"];
    case "opencode":
      return ["openrouter", "openai", "anthropic"];
    default: {
      const _exhaustiveCheck: never = agent;
      throw new Error(
        `unsupported agent for daemon provider scope: ${_exhaustiveCheck}`,
      );
    }
  }
}

function hasRequiredDaemonProviderScopes(params: {
  claims: NonNullable<DaemonTokenAuthContext["claims"]>;
  agent: NonNullable<
    Awaited<ReturnType<typeof getAgentRunContextByRunId>>
  >["agent"];
}): boolean {
  return requiredDaemonProviderScopesForAgent(params.agent).every((provider) =>
    hasDaemonProviderScope(params.claims, provider),
  );
}

async function persistCanonicalEventsOrResponse(params: {
  canonicalEvents: CanonicalEventsPayload | null;
  canPersistCanonicalEvents: boolean;
  runId: string;
  threadId: string;
  threadChatId: string;
  publishLive: boolean;
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
        persistedEvents: [],
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
    if (params.publishLive) {
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
          persistedEvents: [],
        },
      };
    }

    const result = await persistAgUiEvents({
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
        persistedEvents: result.persistedEvents,
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

async function deactivateAcceptedTerminalRun(params: {
  sandboxId: string;
  threadChatId: string;
  runId: string;
}): Promise<void> {
  const otherRunsActive = await hasOtherActiveRuns({
    sandboxId: params.sandboxId,
    threadChatId: params.threadChatId,
    excludeRunId: params.runId,
  });
  if (otherRunsActive) {
    await setActiveThreadChat({
      sandboxId: params.sandboxId,
      threadChatId: params.threadChatId,
      isActive: false,
      runId: params.runId,
    });
    return;
  }
  await setActiveThreadChat({
    sandboxId: params.sandboxId,
    threadChatId: params.threadChatId,
    isActive: false,
    runId: params.runId,
  });
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
  eventId: string;
  seq: number;
  status: "completed" | "failed" | "stopped";
  errorMessage: string | null;
  errorCode: string | null;
  headShaAtCompletion: string | null;
} | null {
  for (const event of canonicalEvents) {
    if (event.category !== "operational") continue;
    if (event.type !== "run-terminal") continue;
    return {
      eventId: event.eventId,
      seq: event.seq,
      status: event.status,
      errorMessage: event.errorMessage ?? null,
      errorCode: event.errorCode ?? null,
      headShaAtCompletion: event.headShaAtCompletion ?? null,
    };
  }
  return null;
}

function buildCanonicalRunTerminalEvent(params: {
  envelope: DaemonEventEnvelopeV2;
  threadId: string;
  threadChatId: string;
  status: "completed" | "failed" | "stopped";
  errorMessage: string | null;
  errorCode: string | null;
  headShaAtCompletion: string | null;
}): CanonicalEventsPayload[number] {
  return {
    payloadVersion: 2,
    eventId: params.envelope.eventId,
    runId: params.envelope.runId,
    threadId: params.threadId,
    threadChatId: params.threadChatId,
    seq: params.envelope.seq,
    timestamp: new Date().toISOString(),
    category: "operational",
    type: "run-terminal",
    status: params.status,
    errorMessage: params.errorMessage,
    errorCode: params.errorCode,
    headShaAtCompletion: params.headShaAtCompletion,
  };
}

function publishMetaEvents(params: {
  metaEvents: NonNullable<DaemonEventAPIBody["metaEvents"]> | null;
  threadId: string;
  threadChatId: string;
}): void {
  if (!params.metaEvents || params.metaEvents.length === 0) {
    return;
  }
  for (const agUi of metaEventsToAgUiEvents(params.metaEvents)) {
    broadcastAgUiEventEphemeral({
      threadChatId: params.threadChatId,
      event: agUi,
    }).catch((error) => {
      console.warn("[daemon-event] meta-event AG-UI broadcast failed", {
        threadId: params.threadId,
        threadChatId: params.threadChatId,
        error,
      });
    });
  }
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

function isFailureRetryable(failureCategory: RuntimeFailureCategory): boolean {
  const action = RUNTIME_FAILURE_ACTION_TABLE[failureCategory];
  return action !== "blocked";
}

function numericUsageField(usage: object, field: string): number {
  const value = Reflect.get(usage, field);
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function buildRunContextFailureUpdates(params: {
  status: "processing" | "completed" | "failed" | "stopped";
  errorMessage: string | null;
  errorCategory: DaemonTerminalErrorCategory;
  failureSource: "custom-error" | "result" | "custom-stop" | "unknown" | null;
}):
  | {
      failureCategory: RuntimeFailureCategory | null;
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
  const failureCategory = mapDaemonTerminalCategoryToRuntimeFailureCategory(
    params.errorCategory,
    params.errorMessage,
  );
  const signatureSource = params.errorMessage;
  return {
    failureCategory,
    failureSource: params.failureSource,
    failureRetryable: isFailureRetryable(failureCategory),
    failureSignatureHash:
      signatureSource != null
        ? hashRuntimeFailureMessage(signatureSource)
        : null,
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

function hasValidThreadChatId(threadChatId: unknown): threadChatId is string {
  return (
    typeof threadChatId === "string" &&
    threadChatId.length > 0 &&
    threadChatId !== "legacy-thread-chat-id"
  );
}

function logDaemonAuthReject(params: {
  reason: string;
  threadId: string;
  threadChatId: string;
  runId: string | null;
  hasDaemonToken?: boolean;
  hasTestAuthHeader?: boolean;
  hasSharedSecretHeader?: boolean;
}): void {
  console.warn("[daemon-event] auth reject", {
    reason: params.reason,
    threadId: params.threadId,
    threadChatId: params.threadChatId,
    runId: params.runId,
    hasDaemonToken: params.hasDaemonToken ?? false,
    hasTestAuthHeader: params.hasTestAuthHeader ?? false,
    hasSharedSecretHeader: params.hasSharedSecretHeader ?? false,
  });
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
  const daemonTokenAuthContext = await getDaemonTokenAuthContextOrNull(request);
  const daemonTestAuthContext = daemonTokenAuthContext
    ? null
    : getDaemonTestAuthContextOrNull(request);
  const daemonAuthContext = daemonTokenAuthContext ?? daemonTestAuthContext;
  const usingDaemonTestAuth = daemonTestAuthContext !== null;
  if (!daemonAuthContext) {
    const hasDaemonToken = request.headers.has("X-Daemon-Token");
    const hasTestAuthHeader = request.headers.has(DAEMON_TEST_AUTH_HEADER);
    const hasSharedSecretHeader = request.headers.has("X-Terragon-Secret");
    logDaemonAuthReject({
      reason: "daemon_auth_context_missing",
      threadId,
      threadChatId,
      runId: envelopeV2?.runId ?? null,
      hasDaemonToken,
      hasTestAuthHeader,
      hasSharedSecretHeader,
    });
    return Response.json(
      {
        success: false,
        error: "daemon_auth_context_missing",
      },
      { status: 401 },
    );
  }
  const userId = daemonAuthContext.userId;
  const claims = daemonAuthContext.claims;

  const rawCanonicalEvents = Array.isArray(json.canonicalEvents)
    ? json.canonicalEvents
    : null;
  const deltas = json.deltas;
  const metaEvents = Array.isArray(json.metaEvents) ? json.metaEvents : null;

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

  if (envelopeV2 && claims && envelopeV2.runId !== claims.runId) {
    logDaemonAuthReject({
      reason: "daemon_event_run_id_claim_mismatch",
      threadId,
      threadChatId,
      runId: envelopeV2.runId,
    });
    return Response.json(
      {
        success: false,
        error: "daemon_event_run_id_claim_mismatch",
        runId: envelopeV2.runId,
      },
      { status: 401 },
    );
  }

  if (envelopeV2 && !claims && !usingDaemonTestAuth) {
    logDaemonAuthReject({
      reason: "daemon_token_claims_required",
      threadId,
      threadChatId,
      runId: envelopeV2.runId,
    });
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
      logDaemonAuthReject({
        reason: "daemon_token_expired",
        threadId,
        threadChatId,
        runId: claims.runId,
      });
      return Response.json(
        {
          success: false,
          error: "daemon_token_expired",
          runId: claims.runId,
        },
        { status: 401 },
      );
    }
    if (claims.threadId !== threadId || claims.threadChatId !== threadChatId) {
      return Response.json(
        {
          success: false,
          error: "daemon_event_run_context_mismatch",
          runId: claims.runId,
        },
        { status: 409 },
      );
    }
  }

  const dbPreflight = await getDaemonEventDbPreflight(db);
  if (!dbPreflight.agentRunContextFailureColumnsReady) {
    return Response.json(
      {
        success: false,
        error: "daemon_event_runtime_session_schema_not_ready",
        missing: dbPreflight.missing,
      },
      { status: 503 },
    );
  }
  const canPersistCanonicalEvents = dbPreflight.agentEventLogReady;
  const canPersistRunContextFailureMeta =
    dbPreflight.agentRunContextFailureColumnsReady;

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

  if (envelopeV2 && !claims) {
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
      claims.runId !== runContext.runId ||
      claims.threadId !== runContext.threadId ||
      claims.threadChatId !== runContext.threadChatId ||
      claims.sandboxId !== runContext.sandboxId ||
      claims.agent !== runContext.agent ||
      claims.nonce !== runContext.tokenNonce ||
      claims.transportMode !== runContext.transportMode ||
      claims.protocolVersion !== runContext.protocolVersion
    ) {
      logDaemonAuthReject({
        reason: "daemon_token_claim_mismatch",
        threadId,
        threadChatId,
        runId: runContext.runId,
      });
      return Response.json(
        {
          success: false,
          error: "daemon_token_claim_mismatch",
          runId: runContext.runId,
        },
        { status: 401 },
      );
    }
    if (
      !hasRequiredDaemonProviderScopes({
        claims,
        agent: runContext.agent,
      })
    ) {
      logDaemonAuthReject({
        reason: "daemon_token_provider_scope_mismatch",
        threadId,
        threadChatId,
        runId: runContext.runId,
      });
      return Response.json(
        {
          success: false,
          error: "daemon_token_provider_scope_mismatch",
          runId: runContext.runId,
        },
        { status: 401 },
      );
    }
    if (!daemonAuthContext.keyId || !runContext.daemonTokenKeyId) {
      logDaemonAuthReject({
        reason: "daemon_token_key_missing",
        threadId,
        threadChatId,
        runId: runContext.runId,
      });
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
      logDaemonAuthReject({
        reason: "daemon_token_key_mismatch",
        threadId,
        threadChatId,
        runId: runContext.runId,
      });
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

  if (rawCanonicalEvents && rawCanonicalEvents.length > 0) {
    const contextMismatch = findCanonicalEventContextMismatch({
      canonicalEvents: rawCanonicalEvents,
      runId: runContext.runId,
      threadId,
      threadChatId,
    });
    if (contextMismatch) {
      return Response.json(
        {
          success: false,
          error: "daemon_event_canonical_event_context_mismatch",
          eventId: contextMismatch.eventId,
          reason: contextMismatch.reason,
        },
        { status: 409 },
      );
    }
  }

  const canonicalEvents = filterCanonicalEventsForDeltaCoexistence({
    canonicalEvents: rawCanonicalEvents,
    deltas,
  });
  const canonicalTerminalBeforePersistence = canonicalEvents
    ? findCanonicalRunTerminalEvent(canonicalEvents)
    : null;

  const canonicalTerminal = canonicalTerminalBeforePersistence;
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

  if (
    daemonRunStatusFromMessages !== "processing" &&
    !envelopeV2 &&
    !canonicalTerminal
  ) {
    return Response.json(
      {
        success: false,
        error: "daemon_event_terminal_requires_v2_envelope",
      },
      { status: 409 },
    );
  }

  if (
    daemonRunStatusFromMessages !== "processing" &&
    !canPersistCanonicalEvents
  ) {
    return Response.json(
      {
        success: false,
        error: "daemon_event_canonical_persistence_unavailable",
        missing: dbPreflight.missing,
      },
      { status: 503 },
    );
  }

  const terminalFailureUpdates = buildRunContextFailureUpdates({
    status: daemonRunStatusFromMessages,
    errorMessage: daemonTerminalErrorInfo.errorMessage,
    errorCategory: daemonTerminalErrorInfo.errorCategory,
    failureSource: terminalFailureSource,
  });
  let terminalFenceOutcome: "committed" | "duplicate" | null = null;
  let terminalEventIdForAck: string | null = null;
  let terminalSeqForAck: number | null = null;
  if (daemonRunStatusFromMessages !== "processing") {
    const terminalEventId = canonicalTerminal?.eventId ?? envelopeV2?.eventId;
    const terminalSeq = canonicalTerminal?.seq ?? envelopeV2?.seq;
    if (!terminalEventId || terminalSeq === undefined) {
      return Response.json(
        {
          success: false,
          error: "daemon_event_terminal_fence_missing_event_identity",
        },
        { status: 409 },
      );
    }
    terminalEventIdForAck = terminalEventId;
    terminalSeqForAck = terminalSeq;

    const terminalFenceResult = await completeAgentRunContextTerminal({
      db,
      runId: runContext.runId,
      userId,
      threadId,
      threadChatId,
      transportMode: runContext.transportMode,
      protocolVersion: runContext.protocolVersion,
      runtimeProvider: runContext.runtimeProvider,
      daemonTokenKeyId: runContext.daemonTokenKeyId,
      terminalStatus: daemonRunStatusFromMessages,
      lastAcceptedSeq: terminalSeq,
      terminalEventId,
      failureUpdates: terminalFailureUpdates,
    });
    if (terminalFenceResult.status === "rejected") {
      return Response.json(
        {
          success: false,
          error: "daemon_event_terminal_run_context_cas_failed",
          reason: terminalFenceResult.reason,
          runId: runContext.runId,
        },
        { status: 409 },
      );
    }
    terminalFenceOutcome = terminalFenceResult.status;
    runContext = terminalFenceResult.runContext;
    if (terminalFenceOutcome === "duplicate") {
      return jsonTerminalAckResponse({
        status: 202,
        deduplicated: true,
        reason: "run_terminal_ignored",
        runId: runContext.runId,
        acknowledgedEventId: terminalEventIdForAck,
        acknowledgedSeq: terminalSeqForAck,
      });
    }
  }

  let canonicalEventsForPersistence: CanonicalEventsPayload | null =
    canonicalEvents;
  if (
    daemonRunStatusFromMessages !== "processing" &&
    envelopeV2 &&
    !canonicalTerminal
  ) {
    const synthesizedTerminal = buildCanonicalRunTerminalEvent({
      envelope: envelopeV2,
      threadId,
      threadChatId,
      status: daemonRunStatusFromMessages,
      errorMessage: daemonTerminalErrorInfo.errorMessage,
      errorCode: daemonTerminalErrorInfo.errorCategory,
      headShaAtCompletion: effectiveHeadShaAtCompletion,
    });
    canonicalEventsForPersistence = canonicalEventsForPersistence
      ? [...canonicalEventsForPersistence, synthesizedTerminal]
      : [synthesizedTerminal];
  }

  const canonicalPersistence = await persistCanonicalEventsOrResponse({
    canonicalEvents: canonicalEventsForPersistence,
    canPersistCanonicalEvents,
    runId: runContext.runId,
    threadId,
    threadChatId,
    publishLive: daemonRunStatusFromMessages === "processing",
  });
  if (canonicalPersistence.response) {
    return canonicalPersistence.response;
  }

  publishMetaEvents({ metaEvents, threadId, threadChatId });

  const shouldIgnoreTerminalRun =
    runContext !== null &&
    (claims !== null || (usingDaemonTestAuth && envelopeV2 !== null)) &&
    canonicalTerminal === null &&
    daemonRunStatusFromMessages === "processing" &&
    (runContext.status === "completed" ||
      runContext.status === "failed" ||
      runContext.status === "stopped");
  if (shouldIgnoreTerminalRun) {
    return jsonTerminalAckResponse({
      status: 202,
      deduplicated: true,
      reason: "run_terminal_ignored",
      runId: runContext.runId,
      acknowledgedEventId: envelopeV2?.eventId ?? null,
      acknowledgedSeq: envelopeV2?.seq ?? null,
    });
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

  // Terminal transitions must be fenced across canonical runtime status surfaces.
  // Canonical terminal events carry their own event id + seq; message-derived
  // terminals still require envelope v2 so the daemon can retry fail-closed.
  const fenceTerminalTransition =
    daemonRunStatusFromMessages !== "processing" &&
    (envelopeV2 != null || canonicalTerminal != null);

  // Prefer computing context usage from the last non-result message's usage
  // fields when available. Do not sum across all messages.
  const computedContextUsage = (() => {
    try {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || message.type === "result") continue;
        if (!("message" in message)) continue;
        if ("parent_tool_use_id" in message && message.parent_tool_use_id) {
          continue;
        }
        const messagePayload = message.message;
        if (typeof messagePayload !== "object" || messagePayload === null) {
          continue;
        }
        if (!("usage" in messagePayload)) continue;
        const usage = messagePayload.usage;
        if (typeof usage !== "object" || usage === null) continue;
        const input = numericUsageField(usage, "input_tokens");
        const output = numericUsageField(usage, "output_tokens");
        const cacheCreate = numericUsageField(
          usage,
          "cache_creation_input_tokens",
        );
        const cacheRead = numericUsageField(usage, "cache_read_input_tokens");
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
      ? {
          success: true,
          threadChatMessageSeq: null,
          terminalRecoveryQueued: false,
        }
      : await handleDaemonEvent({
          messages,
          threadId,
          threadChatId,
          userId,
          timezone,
          contextUsage: computedContextUsage ?? null,
          runId: authoritativeRunId,
          runContext,
          deferTerminalTransitionToRoute: fenceTerminalTransition,
        });
  } catch (error) {
    console.error(
      "[daemon-event] UNHANDLED ERROR in main processing — FULL ERROR:",
      error,
    );
    if (runContext && !fenceTerminalTransition) {
      await updateRunContextIfPresent({
        status: "failed",
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
          await Promise.all([
            db
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
              ),
            updateRunContextIfPresent({
              previousResponseId: json.codexPreviousResponseId,
            }),
          ]);
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

  // Now that the coordinator tick succeeded, finalize the terminal run status.
  // This was deferred from the postHandleOps block so that a tick failure
  // keeps the run non-terminal and allows daemon retries to re-enter the
  // main processing path. Both writes are awaited to prevent silent drops.
  {
    const terminalOps: Array<Promise<unknown>> = [];

    if (fenceTerminalTransition) {
      const terminalStatusForTransition = result.terminalRecoveryQueued
        ? ("completed" as const)
        : resolvedStatus;
      const eventType =
        terminalStatusForTransition === "stopped"
          ? ("assistant.message_stop" as const)
          : terminalStatusForTransition === "failed"
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

      await deactivateAcceptedTerminalRun({
        sandboxId: runContext.sandboxId,
        threadChatId,
        runId: runContext.runId,
      });

      if (result.terminalRecoveryQueued) {
        await Promise.all([
          updateThreadChatTerminalMetadataIfTerminal({
            db,
            userId,
            threadId,
            threadChatId,
            updates: {
              errorMessage: null,
              errorMessageInfo: null,
            },
          }),
          updateRunContextIfPresent({
            status: "completed",
            ...buildRunContextFailureUpdates({
              status: "completed",
              errorMessage: null,
              errorCategory: "unknown",
              failureSource: null,
            }),
          }),
        ]);
      } else if (resolvedStatus === "failed") {
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
              error: r.reason,
            });
          }
        }
      }
    }
  }

  if (
    daemonRunStatusFromMessages !== "processing" &&
    canonicalPersistence.summary.persistedEvents.length > 0
  ) {
    await publishPersistedAgUiEvents({
      threadChatId,
      persistedEvents: canonicalPersistence.summary.persistedEvents,
      insertedEventIds: canonicalPersistence.summary.insertedEventIds,
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
  // of the run is already in agentRunContext.status.
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

  return jsonTerminalAckResponse({
    acknowledgedEventId: terminalEventIdForAck ?? envelopeV2?.eventId ?? null,
    acknowledgedSeq: terminalSeqForAck ?? envelopeV2?.seq ?? null,
  });
}

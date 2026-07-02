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
  getAgentRunContextByRunId,
  updateAgentRunContext,
} from "@terragon/shared/model/agent-run-context";
import {
  getThreadChat,
  getThreadMinimal,
  touchThreadChatUpdatedAt,
  updateThreadChat,
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
import {
  hasOtherActiveRuns,
  setActiveThreadChat,
} from "@/agent/sandbox-resource";
import { messagesIndicateRecoverableFailure } from "@/server-lib/daemon-event/message-parser";
import { recordAgentTraceSpan } from "@/lib/agent-trace";
import {
  type DaemonTokenAuthContext,
  type DaemonTokenProvider,
  getDaemonTokenAuthContextOrNull,
  hasDaemonProviderScope,
} from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  type AgUiPublishRow,
  broadcastAgUiEventEphemeral,
  buildDeltaRunEndRows,
  metaEventsToAgUiEvents,
} from "@/server-lib/ag-ui-publisher";
import { checkpointThread } from "@/server-lib/checkpoint-thread";
import {
  buildPreLegacyAgUiCommitPlan,
  type CanonicalPersistenceSummary,
  commitPreLegacyAgUiEvents,
  commitTerminalAgUiEvents,
  type DaemonEventEnvelopeV2,
  filterCanonicalEventsForDeltaCoexistence,
  findCanonicalEventContextMismatch,
  findCanonicalRunTerminalEvent,
  splitCanonicalEventsForCommit,
} from "@/server-lib/daemon-event/event-commit";
import {
  buildFailedTerminalErrorMetadata,
  buildTerminalLifecyclePolicy,
  shouldQueueTerminalCheckpoint,
  type TerminalCheckpointReadyStatus,
} from "@/server-lib/daemon-event/run-completion";
import { commitTerminalRunAndChatStatus } from "@/server-lib/commit-terminal-run";
import { getDaemonEventDbPreflight } from "@/server-lib/daemon-event-db-preflight";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";

const DAEMON_TEST_AUTH_HEADER = "X-Terragon-Test-Daemon-Auth";
const DAEMON_TEST_USER_ID_HEADER = "X-Terragon-Test-User-Id";
const DAEMON_TEST_AUTH_ENABLED_VALUE = "enabled";

type TerminalAckBase = {
  status?: number;
  deduplicated?: true;
  reason?: string;
  runId?: string;
  acknowledgedEventId: string | null;
  acknowledgedSeq: number | null;
};

type TerminalAckState = TerminalAckBase;

function jsonTerminalAckResponse(state: TerminalAckState): Response {
  return Response.json(
    {
      success: true,
      ...(state.deduplicated ? { deduplicated: true } : {}),
      ...(state.reason ? { reason: state.reason } : {}),
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
    if (
      "session_id" in message &&
      typeof message.session_id === "string" &&
      message.session_id.length
    ) {
      return message.session_id;
    }
  }
  return null;
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
  return typeof threadChatId === "string" && threadChatId.length > 0;
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
    // Daemons may omit timezone, so we fallback to UTC.
    timezone = "UTC",
    transportMode = "acp",
    protocolVersion = 2,
  } = json;
  const rawThreadChatId = json.threadChatId;
  if (!hasValidThreadChatId(rawThreadChatId)) {
    return Response.json(
      {
        success: false,
        error: "daemon_event_requires_thread_chat_id",
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
  const daemonEventReceivedAtMs = Date.now();

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
  recordAgentTraceSpan({
    traceId: authoritativeRunId,
    name: "server.daemon_event.received",
    startedAtMs: daemonEventReceivedAtMs,
    endedAtMs: daemonEventReceivedAtMs,
    attributes: {
      threadId,
      threadChatId,
      runId: authoritativeRunId,
      payloadVersion: json.payloadVersion ?? null,
      seq: envelopeV2?.seq ?? null,
      canonicalEventCount: rawCanonicalEvents?.length ?? 0,
      deltaCount: deltas?.length ?? 0,
      metaEventCount: metaEvents?.length ?? 0,
      daemonEventId: envelopeV2?.eventId ?? null,
      daemonEventReceivedAtMs,
    },
  });
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

  const canonicalEventsAfterDeltaFilter =
    filterCanonicalEventsForDeltaCoexistence({
      canonicalEvents: rawCanonicalEvents,
      deltas,
    });
  // A terminal batch can still carry a RECOVERABLE failure (rate-limit,
  // OAuth-revoked, prompt-too-long). When it does, drop the canonical
  // run-terminal so the message-based recovery path can re-queue instead of
  // fencing the run to a hard stop; recovery terminates itself if it fails.
  //
  // K2: prefer the daemon's typed `recoverable` classification on the terminal.
  // Fall back to re-parsing raw messages for terminals from daemon bundles that
  // predate the field. Wave 4 deletes the `||` fallback and
  // messagesIndicateRecoverableFailure once every daemon stamps the field.
  const recoverableTerminalCandidate = canonicalEventsAfterDeltaFilter
    ? findCanonicalRunTerminalEvent(canonicalEventsAfterDeltaFilter)
    : null;
  const isRecoverableResult =
    recoverableTerminalCandidate?.recoverable != null ||
    messagesIndicateRecoverableFailure({
      messages,
      agent: runContext?.agent,
      timezone,
    });
  const canonicalEvents =
    isRecoverableResult && canonicalEventsAfterDeltaFilter
      ? canonicalEventsAfterDeltaFilter.filter(
          (event) => event.type !== "run-terminal",
        )
      : canonicalEventsAfterDeltaFilter;
  const canonicalTerminalBeforePersistence = canonicalEvents
    ? findCanonicalRunTerminalEvent(canonicalEvents)
    : null;

  const canonicalTerminal = canonicalTerminalBeforePersistence;
  // The canonical run-terminal is the sole completion authority — daemons emit it
  // alongside any terminal message (deriveRunTerminalFromMessages in the daemon
  // normalizer). The server inspects raw messages only for recoverability above,
  // never to decide completion itself.
  const daemonRunStatusFromMessages:
    | "processing"
    | "completed"
    | "failed"
    | "stopped" = canonicalTerminal ? canonicalTerminal.status : "processing";
  const daemonTerminalErrorInfo: {
    errorMessage: string | null;
    errorCategory: DaemonTerminalErrorCategory;
  } = canonicalTerminal
    ? {
        errorMessage: canonicalTerminal.errorMessage,
        errorCategory: canonicalTerminal.errorMessage
          ? classifyDaemonTerminalErrorCategory(canonicalTerminal.errorMessage)
          : "unknown",
      }
    : { errorMessage: null, errorCategory: "unknown" };
  const terminalFailureSource =
    daemonRunStatusFromMessages === "stopped"
      ? ("custom-stop" as const)
      : daemonRunStatusFromMessages === "failed"
        ? ("custom-error" as const)
        : null;

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
  // Captured from the atomic fence+transition below so the terminal-state
  // machinery further down (CAS verify, checkpoint gating, metadata) keys off the
  // transition that already ran inside the fence transaction.
  let terminalChatTransition: Awaited<
    ReturnType<typeof commitTerminalRunAndChatStatus>
  >["transition"] = null;
  let terminalCheckpointReadyStatus: TerminalCheckpointReadyStatus | null =
    null;
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

    // Derive the coupled chat transition up front. `terminalRecoveryQueued` is
    // provably false whenever the fence runs (recoverable terminals are dropped
    // before this point), so `daemonRunStatusFromMessages` IS the terminal status
    // for the transition — no need to wait for handleDaemonEvent.
    const terminalThreadForPolicy =
      daemonRunStatusFromMessages === "completed"
        ? await getThreadMinimal({ db, threadId, userId })
        : null;
    const disableGitCheckpointing =
      !!terminalThreadForPolicy?.disableGitCheckpointing;
    const terminalPolicy = buildTerminalLifecyclePolicy({
      status: daemonRunStatusFromMessages,
      disableGitCheckpointing,
    });
    terminalCheckpointReadyStatus = terminalPolicy.checkpointReadyStatus;

    // Fence the run-context terminal AND transition thread_chat.status in ONE
    // transaction. This is the derived-status choke point: no early return or
    // error between here and the old late transition can split the two surfaces.
    const commit = await commitTerminalRunAndChatStatus({
      db,
      fence: {
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
      },
      transition: {
        userId,
        threadId,
        threadChatId,
        eventType: terminalPolicy.eventType,
        markAsUnread: true,
        requireStatusTransitionForChatUpdates: true,
        skipBroadcast: true,
      },
      disableGitCheckpointing,
    });
    const terminalFenceResult = commit.fence;
    if (!terminalFenceResult || terminalFenceResult.status === "rejected") {
      return Response.json(
        {
          success: false,
          error: "daemon_event_terminal_run_context_cas_failed",
          reason: terminalFenceResult?.reason,
          runId: runContext.runId,
        },
        { status: 409 },
      );
    }
    terminalFenceOutcome = terminalFenceResult.status;
    runContext = terminalFenceResult.runContext;
    terminalChatTransition = commit.transition;
  }

  const {
    canonicalEventsForPersistence,
    terminalCanonicalEventsForPersistence,
  } = splitCanonicalEventsForCommit(canonicalEvents);

  const preLegacyCommitPlan = buildPreLegacyAgUiCommitPlan({
    canPersistCanonicalEvents,
    envelopeV2,
    messages,
    canonicalEventsForPersistence,
    deltas,
    runId: authoritativeRunId,
  });
  let canonicalPersistence: {
    summary: CanonicalPersistenceSummary;
    response?: undefined;
  };

  const preLegacyCommit = await commitPreLegacyAgUiEvents({
    db,
    canPersistCanonicalEvents,
    runId: runContext.runId,
    threadId,
    threadChatId,
    plan: preLegacyCommitPlan,
    canonicalEventsAttempted: canonicalEventsForPersistence?.length ?? 0,
  });
  if (!preLegacyCommit.ok) {
    return Response.json(preLegacyCommit.body, {
      status: preLegacyCommit.status,
    });
  }
  canonicalPersistence = { summary: preLegacyCommit.summary };

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

  // Before the terminal marker, close any (messageId, kind) lifecycles that
  // the delta ingestion path opened for this run but never closed. Without
  // the synthetic ENDs the AG-UI event log is not protocol-compliant and the
  // SSE reader can close on RUN_FINISHED before clients see the END rows.
  // These are persisted alongside terminal canonical events in a single call
  // below (both are terminal-only operations that need higher seq than the
  // main merged persist above).
  let deltaEndRows: AgUiPublishRow[] = [];
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
        deltaEndRows = buildDeltaRunEndRows({
          runId: authoritativeRunId,
          openMessages,
        });
      }
    } catch (error) {
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

  // Terminal canonical events (RUN_FINISHED / RUN_ERROR) and delta-end rows
  // are persisted AFTER handleDaemonEvent so they acquire a higher
  // per-thread-chat seq than any side-effect MESSAGES_SNAPSHOT or rich-part
  // rows written for this same batch. Replay is ordered by seq ASC, and
  // AG-UI's client-side verifyEvents forbids any event after RUN_ERROR /
  // RUN_FINISHED — out-of-order seq would surface as "Cannot send event type
  // 'MESSAGES_SNAPSHOT': The run has already errored with 'RUN_ERROR'" on
  // reconnect. The terminal commit helper publishes only after the ordered
  // persist succeeds.

  // Heartbeat shortcut: empty messages skip message/event persistence,
  // envelope validation, and run-context status transitions.
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
  let skipLegacyRuntimeTranscriptPersistence = false;
  try {
    const isCanonicalOnlyTerminalBatch =
      canonicalTerminal != null &&
      messages.length === 0 &&
      (!deltas || deltas.length === 0);
    const hasNativeRuntimeEvents =
      (canonicalEvents != null && canonicalEvents.length > 0) ||
      (deltas != null && deltas.length > 0);
    skipLegacyRuntimeTranscriptPersistence =
      canPersistCanonicalEvents && envelopeV2 != null && hasNativeRuntimeEvents;
    const shouldSkipDuplicateTerminalProjection =
      terminalFenceOutcome === "duplicate" &&
      !messages.some((message) => message.type === "assistant") &&
      (!deltas || deltas.length === 0);
    if (shouldSkipDuplicateTerminalProjection || isCanonicalOnlyTerminalBatch) {
      result = {
        success: true,
        threadChatMessageSeq: null,
        terminalRecoveryQueued: false,
      };
    } else {
      result = await handleDaemonEvent({
        messages,
        threadId,
        threadChatId,
        userId,
        timezone,
        contextUsage: computedContextUsage ?? null,
        runId: authoritativeRunId,
        runContext,
        deferTerminalTransitionToRoute: fenceTerminalTransition,
        skipThreadChatPersistence: skipLegacyRuntimeTranscriptPersistence,
      });
    }
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

  // Rich-part AG-UI rows were already persisted in the merged persist call
  // above (canonical + delta + rich-part rows in a single transaction).
  // The old second toDBMessage call is eliminated — the precomputed
  // results were used to build richPartRows before handleDaemonEvent.

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
    if (resolvedSessionId) {
      postHandleOps.push(
        updateThreadChat({
          db,
          userId,
          threadId,
          threadChatId,
          updates: { sessionId: resolvedSessionId },
          skipBroadcast: true,
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
      // lose the daemon completion signal for runtime sessions.
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
      // The terminal chat transition already ran atomically with the fence
      // above; reuse its result. `checkpointReadyStatus` was captured from the
      // same buildTerminalLifecyclePolicy call.
      const checkpointReadyStatus = terminalCheckpointReadyStatus;
      const didUpdateStatus = terminalChatTransition?.didUpdateStatus ?? false;
      const updatedStatus = terminalChatTransition?.updatedStatus;

      let latestThreadChatAfterTransition:
        | Awaited<ReturnType<typeof getThreadChat>>
        | undefined;
      if (updatedStatus && !didUpdateStatus) {
        latestThreadChatAfterTransition = await getThreadChat({
          db,
          userId,
          threadId,
          threadChatId,
        });
        if (
          !latestThreadChatAfterTransition ||
          latestThreadChatAfterTransition.status !== updatedStatus
        ) {
          return Response.json(
            {
              success: false,
              error: "daemon_event_terminal_thread_chat_cas_failed",
              expectedStatus: updatedStatus,
              actualStatus: latestThreadChatAfterTransition?.status ?? null,
            },
            { status: 409 },
          );
        }
      }
      if (
        checkpointReadyStatus !== null &&
        !didUpdateStatus &&
        latestThreadChatAfterTransition === undefined
      ) {
        latestThreadChatAfterTransition = await getThreadChat({
          db,
          userId,
          threadId,
          threadChatId,
        });
      }
      if (
        shouldQueueTerminalCheckpoint({
          checkpointReadyStatus,
          didUpdateStatus,
          latestStatus: latestThreadChatAfterTransition?.status,
        })
      ) {
        waitUntil(checkpointThread({ userId, threadId, threadChatId }));
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
        const errorMetadata = buildFailedTerminalErrorMetadata(
          daemonTerminalErrorInfo.errorMessage,
        );
        const { didUpdate } = await updateThreadChatTerminalMetadataIfTerminal({
          db,
          userId,
          threadId,
          threadChatId,
          updates: errorMetadata,
        });
        if (!didUpdate) {
          // The chat was not in a terminal status when we tried to attach the
          // error (the terminal transition raced — e.g. the deferred Codex
          // path finalized while the chat was still booting). Without this the
          // failure is silently dropped and the user sees a blank task. The
          // run is authoritatively failed, so force the error onto the chat.
          console.warn(
            "[daemon-event] failed-terminal error metadata write was gated out; forcing",
            { threadId, threadChatId, runId: runContext?.runId ?? null },
          );
          await updateThreadChatTerminalMetadataIfTerminal({
            db,
            userId,
            threadId,
            threadChatId,
            updates: errorMetadata,
            force: true,
          });
        }
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

  // Deferred terminal-event persistence (see note above the heartbeat
  // shortcut). At this point handleDaemonEvent has already written any
  // side-effect MESSAGES_SNAPSHOT rows, so the terminal marker is guaranteed
  // to receive a higher seq and replay in the correct order.
  // Delta-end rows (synthetic TEXT_MESSAGE_END / REASONING_MESSAGE_END for
  // unclosed delta lifecycles) are merged into the same persist call to
  // reduce transaction count.
  if (
    daemonRunStatusFromMessages !== "processing" &&
    (terminalCanonicalEventsForPersistence || deltaEndRows.length > 0)
  ) {
    const terminalCommit = await commitTerminalAgUiEvents({
      db,
      canPersistCanonicalEvents,
      runId: runContext.runId,
      threadId,
      threadChatId,
      terminalCanonicalEventsForPersistence,
      deltaEndRows,
    });
    if (!terminalCommit.ok) {
      return Response.json(terminalCommit.body, {
        status: terminalCommit.status,
      });
    }
  }

  const shouldReturnDuplicateTerminalIgnored =
    terminalFenceOutcome === "duplicate" &&
    !messages.some((message) => message.type === "assistant") &&
    (!deltas || deltas.length === 0);

  return jsonTerminalAckResponse({
    ...(shouldReturnDuplicateTerminalIgnored
      ? {
          status: 202,
          deduplicated: true as const,
          reason: "run_terminal_ignored",
          runId: runContext.runId,
        }
      : {}),
    acknowledgedEventId: terminalEventIdForAck ?? envelopeV2?.eventId ?? null,
    acknowledgedSeq: terminalSeqForAck ?? envelopeV2?.seq ?? null,
  });
}

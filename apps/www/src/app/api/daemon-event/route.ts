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
  markDispatchIntentCompleted,
  markDispatchIntentFailed,
} from "@terragon/shared/model/delivery-loop";
import type { DeliveryLoopFailureCategory } from "@terragon/shared/delivery-loop/domain/failure";
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
import { and, eq } from "drizzle-orm";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import { redis } from "@/lib/redis";

type DaemonEventEnvelopeV2 = {
  payloadVersion: 2;
  eventId: string;
  runId: string;
  seq: number;
};

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
  errorMessage?: string | null,
): DeliveryLoopFailureCategory {
  // Context window overflow is non-retryable regardless of agent type
  if (
    errorMessage &&
    /context.?length.?exceeded|context.?window|ran out of room|exceeds the context window|max.*tokens.*exceeded/i.test(
      errorMessage,
    )
  ) {
    return "config_error";
  }

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

  const v2Workflow = await getActiveWorkflowForThread({ db, threadId });
  const effectiveLoopId = v2Workflow?.id ?? null;
  const hasDeliveryLoop = !!v2Workflow;

  // Acknowledge dispatch intent once the run context is still in a
  // dispatch-pending state. Envelope v2 starts at seq=0, so this must be
  // status-based (idempotent), not seq-based.
  if (
    hasDeliveryLoop &&
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

  if (hasDeliveryLoop) {
    if (!envelopeV2) {
      console.error(
        "[sdlc-loop] rejecting daemon event for enrolled loop without v2 envelope",
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
    if (hasDeliveryLoop && envelopeV2 && claimedProcessingEvent) {
      await rollbackEnrolledLoopProcessingEventClaim({
        loopId: effectiveLoopId!,
        envelope: envelopeV2,
      });
    }
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
    if (hasDeliveryLoop && envelopeV2 && claimedProcessingEvent) {
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
    if (hasDeliveryLoop && envelopeV2 && claimedProcessingEvent) {
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
        updateAgentRunContext({
          db,
          userId,
          runId: runContext.runId,
          updates: {
            resolvedSessionId,
            ...(resolvedStatus === "processing"
              ? { status: "processing" as const }
              : {}),
          },
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

  if (hasDeliveryLoop && envelopeV2) {
    // Route through daemon ingress adapter
    try {
      const { handleDaemonIngress } = await import(
        "@/server-lib/delivery-loop/adapters/ingress/daemon-ingress"
      );
      const ingressResult = await handleDaemonIngress({
        db,
        rawEvent: {
          threadId,
          loopId: effectiveLoopId!,
          runId: envelopeV2.runId,
          status: daemonRunStatusFromMessages as
            | "completed"
            | "failed"
            | "progress"
            | "stopped",
          headSha: null,
          summary: null,
          exitCode: null,
          errorMessage: daemonTerminalErrorInfo?.errorMessage ?? null,
        },
        workflowId: v2Workflow!.id as WorkflowId,
        consecutiveDispatches: 0,
      });
      if (ingressResult.selfDispatch) {
        selfDispatchPayload =
          ingressResult.selfDispatch as unknown as typeof selfDispatchPayload;
      }
    } catch (error) {
      console.error("[sdlc-loop-v2] handleDaemonIngress failed", {
        userId,
        threadId,
        loopId: effectiveLoopId!,
        eventId: envelopeV2.eventId,
        seq: envelopeV2.seq,
        error,
      });
      return new Response(
        "v2 daemon ingress failed after message persistence",
        { status: 500 },
      );
    }
  }

  // Now that the coordinator tick succeeded, finalize the terminal run status.
  // This was deferred from the postHandleOps block so that a tick failure
  // keeps the run non-terminal and allows daemon retries to re-enter the
  // main processing path. Both writes are awaited to prevent silent drops.
  {
    const terminalOps: Array<Promise<unknown>> = [];
    if (runContext && resolvedStatus !== "processing") {
      terminalOps.push(
        updateAgentRunContext({
          db,
          userId,
          runId: runContext.runId,
          updates: { status: resolvedStatus },
        }),
      );
    }
    if (
      hasDeliveryLoop &&
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
            enrolled: hasDeliveryLoop,
            error: r.reason,
          });
        }
      }
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

import {
  DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
  DAEMON_EVENT_CAPABILITIES_HEADER,
  DaemonEventAPIBody,
} from "@terragon/daemon/shared";
import { env } from "@terragon/env/apps-www";
import {
  hasOtherActiveRuns,
  setActiveThreadChat,
} from "@/agent/sandbox-resource";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import {
  getDaemonTokenAuthContextOrNull,
  type DaemonTokenAuthContext,
} from "@/lib/auth-server";
import { toDBMessage } from "@/agent/msg/toDBMessage";
import {
  processDaemonEvent,
  type DaemonEventEnvelopeV2,
} from "@/server-lib/daemon-event-processor";

const DAEMON_TEST_AUTH_HEADER = "X-Terragon-Test-Daemon-Auth";
const DAEMON_TEST_USER_ID_HEADER = "X-Terragon-Test-User-Id";
const DAEMON_TEST_AUTH_ENABLED_VALUE = "enabled";

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
  const { threadId } = json;
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

  if (
    envelopeV2 &&
    daemonAuthContext.claims &&
    envelopeV2.runId !== daemonAuthContext.claims.runId
  ) {
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

  const result = await processDaemonEvent(
    {
      toDBMessage,
      hasOtherActiveRuns,
      setActiveThreadChat,
      updateThreadChatWithTransition,
    },
    {
      body: json,
      envelopeV2,
      daemonAdvertisesEnvelopeV2,
      authContext: daemonAuthContext,
      usingDaemonTestAuth,
      daemonEventReceivedAtMs: Date.now(),
    },
  );

  if (result.kind === "json") {
    return Response.json(result.body, { status: result.status });
  }
  return new Response(result.body, { status: result.status });
}

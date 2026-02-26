import { getUserIdOrNullFromDaemonToken } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import { DaemonEventAPIBody } from "@terragon/daemon/shared";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  getActiveSdlcLoopForThread,
  SDLC_CAUSE_IDENTITY_VERSION,
} from "@terragon/shared/model/sdlc-loop";
import { and, eq, sql } from "drizzle-orm";

type DaemonEventEnvelopeV2 = {
  payloadVersion: 2;
  eventId: string;
  runId: string;
  seq: number;
};

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

async function claimEnrolledLoopDaemonEvent({
  loopId,
  threadId,
  threadChatId,
  envelope,
}: {
  loopId: string;
  threadId: string;
  threadChatId: string;
  envelope: DaemonEventEnvelopeV2;
}): Promise<boolean> {
  const inserted = await db
    .insert(schema.sdlcLoopSignalInbox)
    .values({
      loopId,
      causeType: "daemon_terminal",
      canonicalCauseId: envelope.eventId,
      signalHeadShaOrNull: null,
      causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      payload: {
        payloadVersion: envelope.payloadVersion,
        eventId: envelope.eventId,
        runId: envelope.runId,
        seq: envelope.seq,
        threadId,
        threadChatId,
      },
    })
    .onConflictDoNothing()
    .returning({ id: schema.sdlcLoopSignalInbox.id });

  return inserted.length > 0;
}

export async function POST(request: Request) {
  const json: DaemonEventAPIBody = await request.json();
  const {
    messages,
    threadId,
    threadChatId = LEGACY_THREAD_CHAT_ID,
    // Old clients don't send the timezone, so we fallback to UTC
    timezone = "UTC",
  } = json;
  const envelopeV2 = getDaemonEventEnvelopeV2(json);
  const userId = await getUserIdOrNullFromDaemonToken(request);
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const enrolledLoop = await getActiveSdlcLoopForThread({
    db,
    userId,
    threadId,
  });

  const coordinatorRoutingEnabled = await getFeatureFlagForUser({
    db,
    userId,
    flagName: "sdlcLoopCoordinatorRouting",
  });

  if (enrolledLoop && coordinatorRoutingEnabled) {
    if (!envelopeV2) {
      console.error(
        "[sdlc-loop] rejecting daemon event for enrolled loop without v2 envelope",
        {
          userId,
          threadId,
          loopId: enrolledLoop.id,
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

    const [sequenceState] = await db
      .select({
        maxSeq: sql<
          number | null
        >`max(((${schema.sdlcLoopSignalInbox.payload} ->> 'seq')::bigint))`,
      })
      .from(schema.sdlcLoopSignalInbox)
      .where(
        and(
          eq(schema.sdlcLoopSignalInbox.loopId, enrolledLoop.id),
          eq(schema.sdlcLoopSignalInbox.causeType, "daemon_terminal"),
          sql`${schema.sdlcLoopSignalInbox.payload} ->> 'runId' = ${envelopeV2.runId}`,
        ),
      );

    const maxSeq =
      sequenceState?.maxSeq == null ? null : Number(sequenceState.maxSeq);
    if (
      maxSeq !== null &&
      Number.isFinite(maxSeq) &&
      envelopeV2.seq <= maxSeq
    ) {
      return Response.json(
        {
          success: true,
          deduplicated: true,
          reason: "out_of_order_or_duplicate_seq",
          loopId: enrolledLoop.id,
        },
        { status: 202 },
      );
    }

    const didClaimEvent = await claimEnrolledLoopDaemonEvent({
      loopId: enrolledLoop.id,
      threadId,
      threadChatId,
      envelope: envelopeV2,
    });
    if (!didClaimEvent) {
      return Response.json(
        {
          success: true,
          deduplicated: true,
          reason: "duplicate_event",
          loopId: enrolledLoop.id,
        },
        { status: 202 },
      );
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
  const result = await handleDaemonEvent({
    messages,
    threadId,
    threadChatId,
    userId,
    timezone,
    contextUsage: computedContextUsage ?? null,
  });

  if (!result.success) {
    return new Response(result.error, { status: result.status || 500 });
  }

  return new Response("OK");
}

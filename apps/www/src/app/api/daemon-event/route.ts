import { getUserIdOrNullFromDaemonToken } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import {
  DAEMON_EVENT_CAPABILITIES_HEADER,
  DAEMON_EVENT_VERSION_HEADER,
  DaemonEventAPIBody,
} from "@terragon/daemon/shared";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import {
  getActiveSdlcLoopForThread,
  SDLC_CAUSE_IDENTITY_VERSION,
} from "@terragon/shared/model/sdlc-loop";
import { and, eq, isNull, sql } from "drizzle-orm";
import { runBestEffortSdlcPublicationCoordinator } from "@/server-lib/sdlc-loop/publication";
import { runBestEffortSdlcSignalInboxTick } from "@/server-lib/sdlc-loop/signal-inbox";

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

function buildCoordinatorGuardrailRuntime(loopVersion: unknown) {
  const iterationCount =
    typeof loopVersion === "number" && Number.isFinite(loopVersion)
      ? Math.max(loopVersion, 0)
      : 0;
  return {
    killSwitchEnabled: false,
    cooldownUntil: null,
    maxIterations: null,
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

    const inserted = await tx
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

  let claimedSignalInboxId: string | null = null;

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

    if (envelopeV2) {
      const claimResult = await claimEnrolledLoopDaemonEvent({
        loopId: enrolledLoop.id,
        threadId,
        threadChatId,
        envelope: envelopeV2,
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
        if (claimResult.reason === "duplicate_event") {
          try {
            const guardrailRuntime = buildCoordinatorGuardrailRuntime(
              enrolledLoop.loopVersion,
            );
            await runBestEffortSdlcSignalInboxTick({
              db,
              loopId: enrolledLoop.id,
              leaseOwnerToken: `daemon-event-dedup:${envelopeV2.eventId}:${envelopeV2.seq}`,
              guardrailRuntime,
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
        return Response.json(
          {
            success: true,
            deduplicated: true,
            reason: claimResult.reason,
            loopId: enrolledLoop.id,
            acknowledgedEventId: envelopeV2.eventId,
            acknowledgedSeq: envelopeV2.seq,
          },
          { status: 202 },
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
  try {
    result = await handleDaemonEvent({
      messages,
      threadId,
      threadChatId,
      userId,
      timezone,
      contextUsage: computedContextUsage ?? null,
    });
  } catch (error) {
    await rollbackClaimedSignal({
      reason: "handle_daemon_event_threw",
      error,
    });
    throw error;
  }

  if (!result.success) {
    await rollbackClaimedSignal({
      reason: "handle_daemon_event_failed",
      error: result.error,
    });
    return new Response(result.error, { status: result.status || 500 });
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

  if (enrolledLoop && envelopeV2) {
    try {
      const guardrailRuntime = buildCoordinatorGuardrailRuntime(
        enrolledLoop.loopVersion,
      );
      await runBestEffortSdlcSignalInboxTick({
        db,
        loopId: enrolledLoop.id,
        leaseOwnerToken: `daemon-event:${envelopeV2.eventId}:${envelopeV2.seq}`,
        guardrailRuntime,
      });

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

  return Response.json({
    success: true,
    acknowledgedEventId: envelopeV2?.eventId ?? null,
    acknowledgedSeq: envelopeV2?.seq ?? null,
  });
}

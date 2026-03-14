/**
 * Signal processing for replay: insert, claim, process, complete.
 *
 * Faithfully replicates the production signal-inbox pipeline
 * (apps/www/src/server-lib/delivery-loop/signal-inbox.ts) including
 * gate evaluations, task completion, artifact creation, and review
 * gate replay — without Next.js orchestration or real agent dispatch.
 */

import type { EvalSignal, EvalGateEvent } from "../types";
import type { SharedModules, DB } from "./shared-loader";
import type { SeededState } from "./seed";
import type {
  SdlcLoopCauseType,
  SdlcLoopState,
} from "@terragon/shared/db/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPayloadText(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Re-read loop version from DB (optimistic locking). */
async function freshLoopVersion(
  db: DB,
  shared: SharedModules,
  loopId: string,
  fallback: number,
): Promise<number> {
  const [row] = await db
    .select({ loopVersion: shared.schema.sdlcLoop.loopVersion })
    .from(shared.schema.sdlcLoop)
    .where((shared.eq as any)(shared.schema.sdlcLoop.id, loopId));
  return row?.loopVersion ?? fallback;
}

/**
 * Replay gate events (deep_review / carmack_review) that match a given headSha.
 * In production the agent wakes up and runs the review gate inline; here we
 * replay the captured LLM outputs to exercise the same DB writes.
 */
async function replayGateEvents({
  db,
  shared,
  loopId,
  headSha,
  gateEvents,
  fallbackLoopVersion,
}: {
  db: DB;
  shared: SharedModules;
  loopId: string;
  headSha: string;
  gateEvents: EvalGateEvent[];
  fallbackLoopVersion: number;
}) {
  const matching = gateEvents.filter((e) => e.headSha === headSha);
  for (const event of matching) {
    const ver = await freshLoopVersion(db, shared, loopId, fallbackLoopVersion);

    if (event.gateType === "deep_review") {
      await shared.persistDeepReviewGateResult({
        db,
        loopId,
        headSha,
        loopVersion: ver,
        model: event.model ?? "eval-replay",
        rawOutput: event.rawOutput,
        updateLoopState: true,
      });
    } else if (event.gateType === "carmack_review") {
      await shared.persistCarmackReviewGateResult({
        db,
        loopId,
        headSha,
        loopVersion: ver,
        model: event.model ?? "eval-replay",
        rawOutput: event.rawOutput,
        updateLoopState: true,
      });
    }
    // ci and review_thread gate events are handled by persistGateEvaluationForSignal
  }
}

// ---------------------------------------------------------------------------
// Signal replay
// ---------------------------------------------------------------------------

export type SignalReplayResult = {
  signalIndex: number;
  signalId: string;
  causeType: string;
  previousState: string;
  nextState: string;
  transitionEvent: string | null;
  durationMs: number;
  loopVersion: number;
  fixAttemptCount: number;
  error: string | null;
};

export async function replaySignal({
  db,
  shared,
  seeded,
  signal,
  gateEvents,
}: {
  db: DB;
  shared: SharedModules;
  seeded: SeededState;
  signal: EvalSignal;
  gateEvents?: EvalGateEvent[];
}): Promise<SignalReplayResult> {
  const { schema, eq, nanoid } = shared;
  const startMs = Date.now();

  // Read current loop state
  const [loopBefore] = await db
    .select({
      state: schema.sdlcLoop.state,
      loopVersion: schema.sdlcLoop.loopVersion,
      fixAttemptCount: schema.sdlcLoop.fixAttemptCount,
      currentHeadSha: schema.sdlcLoop.currentHeadSha,
      blockedFromState: schema.sdlcLoop.blockedFromState,
    })
    .from(schema.sdlcLoop)
    .where((eq as any)(schema.sdlcLoop.id, seeded.loopId));

  if (!loopBefore) {
    return {
      signalIndex: signal.index,
      signalId: "",
      causeType: signal.causeType,
      previousState: "unknown",
      nextState: "unknown",
      transitionEvent: null,
      durationMs: Date.now() - startMs,
      loopVersion: 0,
      fixAttemptCount: 0,
      error: "Loop not found",
    };
  }

  const previousState = loopBefore.state;
  const loopVersion = loopBefore.loopVersion ?? 0;

  // 1. Insert signal into sdlcLoopSignalInbox
  const now = new Date();
  const [insertedSignal] = await db
    .insert(schema.sdlcLoopSignalInbox)
    .values({
      loopId: seeded.loopId,
      causeType: signal.causeType as SdlcLoopCauseType,
      canonicalCauseId: signal.canonicalCauseId,
      signalHeadShaOrNull:
        (signal.payload.headSha as string) ??
        (signal.payload.headShaAtCompletion as string) ??
        null,
      causeIdentityVersion: 1,
      payload: signal.payload,
      receivedAt: now,
      committedAt: now, // daemon_terminal requires committedAt
    })
    .returning({ id: schema.sdlcLoopSignalInbox.id });

  const signalId = insertedSignal!.id;

  // 2. Claim signal
  const claimToken = nanoid();
  const claimed = await shared.claimNextUnprocessedSignal({
    db,
    loopId: seeded.loopId,
    claimToken,
    now,
    staleClaimMs: 0,
  });

  if (!claimed) {
    return {
      signalIndex: signal.index,
      signalId,
      causeType: signal.causeType,
      previousState,
      nextState: previousState,
      transitionEvent: null,
      durationMs: Date.now() - startMs,
      loopVersion,
      fixAttemptCount: loopBefore.fixAttemptCount ?? 0,
      error: "Failed to claim signal",
    };
  }

  // 3. Process signal based on causeType and current state
  let transitionEvent: string | null = null;
  let error: string | null = null;

  try {
    await processSignal({
      db,
      shared,
      seeded,
      signal,
      claimed,
      loopBefore,
      loopVersion,
      previousState,
      now,
      gateEvents: gateEvents ?? [],
      setTransitionEvent: (e) => {
        transitionEvent = e;
      },
    });
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
  }

  // 4. Complete signal
  await shared.completeSignalClaim({
    db,
    signalId: claimed.id,
    claimToken,
    now: new Date(),
  });

  // 5. Read final loop state
  const [loopAfter] = await db
    .select({
      state: schema.sdlcLoop.state,
      loopVersion: schema.sdlcLoop.loopVersion,
      fixAttemptCount: schema.sdlcLoop.fixAttemptCount,
    })
    .from(schema.sdlcLoop)
    .where((eq as any)(schema.sdlcLoop.id, seeded.loopId));

  const nextState = loopAfter?.state ?? previousState;

  return {
    signalIndex: signal.index,
    signalId,
    causeType: signal.causeType,
    previousState,
    nextState,
    transitionEvent,
    durationMs: Date.now() - startMs,
    loopVersion: loopAfter?.loopVersion ?? loopVersion,
    fixAttemptCount: loopAfter?.fixAttemptCount ?? 0,
    error,
  };
}

// ---------------------------------------------------------------------------
// Per-causeType processing
// ---------------------------------------------------------------------------

async function processSignal({
  db,
  shared,
  seeded,
  signal,
  claimed,
  loopBefore,
  loopVersion,
  previousState,
  now,
  gateEvents,
  setTransitionEvent,
}: {
  db: DB;
  shared: SharedModules;
  seeded: SeededState;
  signal: EvalSignal;
  claimed: {
    id: string;
    causeType: SdlcLoopCauseType;
    canonicalCauseId: string;
    payload: Record<string, unknown> | null;
    receivedAt: Date;
    claimToken: string;
  };
  loopBefore: {
    state: string;
    loopVersion: number | null;
    fixAttemptCount: number | null;
    currentHeadSha: string | null;
    blockedFromState: string | null;
  };
  loopVersion: number;
  previousState: string;
  now: Date;
  gateEvents: EvalGateEvent[];
  setTransitionEvent: (e: string | null) => void;
}) {
  const causeType = signal.causeType;

  // ── daemon_terminal ──
  if (causeType === "daemon_terminal") {
    // Run gate evaluation (for daemon_terminal this just returns true)
    await shared.persistGateEvaluationForSignal({
      db,
      loop: {
        id: seeded.loopId,
        loopVersion,
        currentHeadSha: loopBefore.currentHeadSha,
        state: previousState as SdlcLoopState,
        blockedFromState:
          (loopBefore.blockedFromState as SdlcLoopState) ?? null,
      },
      signal: claimed,
      now,
    });

    const daemonRunStatus = getPayloadText(signal.payload, "daemonRunStatus");

    if (daemonRunStatus === "stopped") {
      setTransitionEvent("manual_stop");
      const ver = await freshLoopVersion(
        db,
        shared,
        seeded.loopId,
        loopVersion,
      );
      await shared.transitionSdlcLoopState({
        db,
        loopId: seeded.loopId,
        transitionEvent: "manual_stop" as any,
        loopVersion: ver,
      });
      return;
    }

    if (previousState === "planning") {
      setTransitionEvent("plan_completed");
      const ver = await freshLoopVersion(
        db,
        shared,
        seeded.loopId,
        loopVersion,
      );
      await shared.transitionSdlcLoopState({
        db,
        loopId: seeded.loopId,
        transitionEvent: "plan_completed" as any,
        loopVersion: ver,
      });
      return;
    }

    // ── Implementing-phase completion intercept ──
    if (previousState === "implementing" && daemonRunStatus === "completed") {
      const headShaAtCompletion = getPayloadText(
        signal.payload,
        "headShaAtCompletion",
      );
      const effectiveHeadSha =
        headShaAtCompletion || loopBefore.currentHeadSha || "";

      if (effectiveHeadSha) {
        // Fetch latest accepted plan artifact
        const acceptedPlanArtifact = await shared.getLatestAcceptedArtifact({
          db,
          loopId: seeded.loopId,
          phase: "planning" as any,
          includeApprovedForPlanning: true,
        });

        if (acceptedPlanArtifact) {
          // Verify task completion and auto-mark incomplete tasks
          const verified = await shared.verifyPlanTaskCompletionForHead({
            db,
            loopId: seeded.loopId,
            artifactId: acceptedPlanArtifact.id,
            headSha: effectiveHeadSha,
          });

          const unmarkedTaskIds = [
            ...verified.incompleteTaskIds,
            ...verified.invalidEvidenceTaskIds,
          ];
          if (unmarkedTaskIds.length > 0) {
            await shared.markPlanTasksCompletedByAgent({
              db,
              loopId: seeded.loopId,
              artifactId: acceptedPlanArtifact.id,
              completions: unmarkedTaskIds.map((id) => ({
                stableTaskId: id,
                status: "done" as const,
                evidence: {
                  headSha: effectiveHeadSha,
                  note: "auto-marked on implementing completion",
                },
              })),
            });
          }
        }

        // Transition to review_gate
        setTransitionEvent("implementation_completed");
        const ver = await freshLoopVersion(
          db,
          shared,
          seeded.loopId,
          loopVersion,
        );
        await shared.transitionSdlcLoopState({
          db,
          loopId: seeded.loopId,
          transitionEvent: "implementation_completed" as any,
          headSha: effectiveHeadSha,
          loopVersion: ver,
        });

        // Replay gate events (deep_review / carmack_review) for this head
        if (gateEvents.length > 0) {
          await replayGateEvents({
            db,
            shared,
            loopId: seeded.loopId,
            headSha: effectiveHeadSha,
            gateEvents,
            fallbackLoopVersion: ver,
          });
        }
      }
      return;
    }

    // ── review_gate re-dispatch ──
    if (previousState === "review_gate") {
      // Agent woke up to fix things — just check for gate events to replay
      const headSha =
        getPayloadText(signal.payload, "headShaAtCompletion") ||
        getPayloadText(signal.payload, "headSha") ||
        loopBefore.currentHeadSha ||
        "";
      if (headSha && gateEvents.length > 0) {
        await replayGateEvents({
          db,
          shared,
          loopId: seeded.loopId,
          headSha,
          gateEvents,
          fallbackLoopVersion: loopVersion,
        });
      }
      return;
    }

    // Other states: daemon_terminal with no specific handling
    return;
  }

  // ── CI signals ──
  if (
    causeType === "check_run.completed" ||
    causeType === "check_suite.completed"
  ) {
    await shared.persistGateEvaluationForSignal({
      db,
      loop: {
        id: seeded.loopId,
        loopVersion,
        currentHeadSha: loopBefore.currentHeadSha,
        state: previousState as SdlcLoopState,
        blockedFromState:
          (loopBefore.blockedFromState as SdlcLoopState) ?? null,
      },
      signal: claimed,
      now,
    });
    return;
  }

  // ── Review signals ──
  if (
    causeType === "pull_request_review" ||
    causeType === "pull_request_review_comment"
  ) {
    await shared.persistGateEvaluationForSignal({
      db,
      loop: {
        id: seeded.loopId,
        loopVersion,
        currentHeadSha: loopBefore.currentHeadSha,
        state: previousState as SdlcLoopState,
        blockedFromState:
          (loopBefore.blockedFromState as SdlcLoopState) ?? null,
      },
      signal: claimed,
      now,
    });
    return;
  }

  // ── PR synchronize → pr_linked ──
  if (causeType === "pull_request.synchronize") {
    if (previousState === "awaiting_pr_link") {
      const prNumber = signal.payload.prNumber as number | undefined;
      const repoFullName = signal.payload.repoFullName as string | undefined;
      const pullRequestUrl = signal.payload.pullRequestUrl as
        | string
        | undefined;

      if (prNumber && repoFullName) {
        const ver = await freshLoopVersion(
          db,
          shared,
          seeded.loopId,
          loopVersion,
        );
        await shared.createPrLinkArtifact({
          db,
          loopId: seeded.loopId,
          loopVersion: ver,
          payload: {
            repoFullName,
            prNumber,
            pullRequestUrl: pullRequestUrl ?? "",
            operation: "linked",
          },
        });

        setTransitionEvent("pr_linked");
        const ver2 = await freshLoopVersion(
          db,
          shared,
          seeded.loopId,
          loopVersion,
        );
        await shared.transitionSdlcLoopState({
          db,
          loopId: seeded.loopId,
          transitionEvent: "pr_linked" as any,
          loopVersion: ver2,
        });
      }
    }
    return;
  }

  // ── PR closed ──
  if (causeType === "pull_request.closed") {
    const merged = signal.payload.merged as boolean | undefined;
    const event = merged ? "pr_merged" : "pr_closed_unmerged";
    setTransitionEvent(event);

    const ver = await freshLoopVersion(db, shared, seeded.loopId, loopVersion);
    await shared.transitionSdlcLoopState({
      db,
      loopId: seeded.loopId,
      transitionEvent: event as any,
      loopVersion: ver,
    });
    return;
  }

  // Other cause types: no-op
}

/**
 * Signal processing for replay: insert, claim, process, complete.
 *
 * Maps each fixture signal into DB operations mirroring the production
 * signal-inbox pipeline, but without Next.js orchestration.
 */

import type { EvalSignal } from "../types";
import type { SharedModules, DB } from "./shared-loader";
import type { SeededState } from "./seed";
import type {
  SdlcLoopCauseType,
  SdlcLoopState,
} from "@terragon/shared/db/types";

// ---------------------------------------------------------------------------
// Cause-type to transition-event mapping
// ---------------------------------------------------------------------------

/**
 * Derives the appropriate SdlcLoopTransitionEvent from the signal's causeType
 * and payload. This is a simplified version of the production routing logic —
 * in replay mode we only exercise the state machine, not the full orchestrator.
 */
function deriveTransitionEvent(
  signal: EvalSignal,
  currentState: string,
): string | null {
  const payload = signal.payload;
  const causeType = signal.causeType;

  if (causeType === "daemon_terminal") {
    const status = payload.daemonRunStatus as string | undefined;
    if (status === "stopped") return "manual_stop";

    // daemon_terminal in implementing → implementation_completed
    if (currentState === "implementing") return "implementation_completed";
    // daemon_terminal in planning → plan_completed
    if (currentState === "planning") return "plan_completed";
    return null;
  }

  if (
    causeType === "check_run.completed" ||
    causeType === "check_suite.completed"
  ) {
    // CI signals: handled via persistSdlcCiGateEvaluation which
    // internally calls transitionSdlcLoopState. Return null to indicate
    // the gate evaluation handles the transition.
    return null;
  }

  if (
    causeType === "pull_request_review" ||
    causeType === "pull_request_review_comment"
  ) {
    // Review signals: handled via persistGateEvaluationForSignal
    return null;
  }

  if (causeType === "pull_request.synchronize") {
    if (currentState === "awaiting_pr_link") return "pr_linked";
    return null;
  }

  if (causeType === "pull_request.closed") {
    const merged = payload.merged as boolean | undefined;
    return merged ? "pr_merged" : "pr_closed_unmerged";
  }

  if (causeType === "pull_request.reopened") {
    // No direct transition event — usually re-enrolls the loop
    return null;
  }

  return null;
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
}: {
  db: DB;
  shared: SharedModules;
  seeded: SeededState;
  signal: EvalSignal;
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

  // 3. Process: gate evaluation + state transition
  let transitionEvent: string | null = null;
  let error: string | null = null;

  try {
    // For gate-evaluated signals (CI checks, reviews), run persistGateEvaluationForSignal
    const isFeedbackSignal =
      signal.causeType === "daemon_terminal" ||
      signal.causeType === "check_run.completed" ||
      signal.causeType === "check_suite.completed" ||
      signal.causeType === "pull_request_review" ||
      signal.causeType === "pull_request_review_comment";

    if (isFeedbackSignal) {
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
    }

    // Derive explicit transition event
    transitionEvent = deriveTransitionEvent(signal, previousState);

    if (transitionEvent) {
      // Re-read loop version after gate evaluation may have incremented it
      const [freshLoop] = await db
        .select({ loopVersion: schema.sdlcLoop.loopVersion })
        .from(schema.sdlcLoop)
        .where((eq as any)(schema.sdlcLoop.id, seeded.loopId));
      const freshVersion = freshLoop?.loopVersion ?? loopVersion;

      const headSha =
        (signal.payload.headSha as string) ??
        (signal.payload.headShaAtCompletion as string) ??
        undefined;

      await shared.transitionSdlcLoopState({
        db,
        loopId: seeded.loopId,
        transitionEvent: transitionEvent as any,
        loopVersion: freshVersion,
        headSha,
      });
    }
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

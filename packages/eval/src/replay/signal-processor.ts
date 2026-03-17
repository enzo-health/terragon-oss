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
import type { SdlcLoopCauseType } from "@terragon/shared/db/types";

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

  // Separate review gates from CI/review_thread gates — reviews must
  // complete first, then if all pass we fire review_passed before
  // processing CI/review_thread gates.
  const reviewGates = matching.filter(
    (e) => e.gateType === "deep_review" || e.gateType === "carmack_review",
  );
  const postReviewGates = matching.filter(
    (e) => e.gateType === "ci" || e.gateType === "review_thread",
  );

  let deepPassed = false;
  let carmackPassed = false;

  for (const event of reviewGates) {
    const ver = await freshLoopVersion(db, shared, loopId, fallbackLoopVersion);

    if (event.gateType === "deep_review") {
      const result = await shared.persistDeepReviewGateResult({
        db,
        loopId,
        headSha,
        loopVersion: ver,
        model: event.model ?? "eval-replay",
        rawOutput: event.rawOutput,
        updateLoopState: true,
      });
      deepPassed = result.gatePassed;
    } else if (event.gateType === "carmack_review") {
      const result = await shared.persistCarmackReviewGateResult({
        db,
        loopId,
        headSha,
        loopVersion: ver,
        model: event.model ?? "eval-replay",
        rawOutput: event.rawOutput,
        updateLoopState: true,
      });
      carmackPassed = result.gatePassed;
    }
  }

  // If both reviews passed, fire review_passed to advance to ci_gate
  if (deepPassed && carmackPassed) {
    const ver = await freshLoopVersion(db, shared, loopId, fallbackLoopVersion);
    await shared.transitionSdlcLoopState({
      db,
      loopId,
      transitionEvent: "review_passed" as any,
      headSha,
      loopVersion: ver + 1,
    });
  }

  // Process CI and review_thread gate events
  let allPostReviewPassed = postReviewGates.length > 0;
  for (const event of postReviewGates) {
    const ver = await freshLoopVersion(db, shared, loopId, fallbackLoopVersion);
    const transitionEvent = event.gatePassed
      ? event.gateType === "ci"
        ? "ci_gate_passed"
        : "review_threads_gate_passed"
      : event.gateType === "ci"
        ? "ci_gate_blocked"
        : "review_threads_gate_blocked";
    await shared.transitionSdlcLoopState({
      db,
      loopId,
      transitionEvent: transitionEvent as any,
      headSha,
      loopVersion: ver + 1,
    });
    if (!event.gatePassed) allPostReviewPassed = false;
  }

  // If all gates passed (review + CI + review_thread), auto-advance
  // through ui_gate → awaiting_pr_link → babysitting → done.
  // In production these steps involve UI smoke tests and PR linking
  // which we don't replay — we just advance the state machine.
  if (deepPassed && carmackPassed && allPostReviewPassed) {
    const advanceEvents = [
      "ui_smoke_passed",
      "pr_linked",
      "babysit_passed",
      "pr_merged",
    ] as const;
    for (const evt of advanceEvents) {
      const ver = await freshLoopVersion(
        db,
        shared,
        loopId,
        fallbackLoopVersion,
      );
      const outcome = await shared.transitionSdlcLoopState({
        db,
        loopId,
        transitionEvent: evt as any,
        headSha,
        loopVersion: ver + 1,
      });
      // Stop if the transition didn't apply (wrong state)
      if (outcome !== "updated") break;
    }
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

        // Transition to review_gate (increment loopVersion like production)
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
          loopVersion: ver + 1,
        });

        // Replay gate events (deep_review / carmack_review) for this head
        if (gateEvents.length > 0) {
          await replayGateEvents({
            db,
            shared,
            loopId: seeded.loopId,
            headSha: effectiveHeadSha,
            gateEvents,
            fallbackLoopVersion: ver + 1,
          });
        }
      }
      return;
    }

    // ── review_gate re-dispatch ──
    // In production, between signals the agent already ran the gate pipeline
    // (blocking → implementing), pushed a fix, and re-completed. We replay
    // this by directly updating currentHeadSha and loopVersion (avoiding
    // the state machine's fixAttemptCount increment for the synthetic
    // transition), then replaying the captured gate evaluations which will
    // apply the real state transitions.
    if (previousState === "review_gate") {
      const headSha =
        getPayloadText(signal.payload, "headShaAtCompletion") ||
        getPayloadText(signal.payload, "headSha") ||
        loopBefore.currentHeadSha ||
        "";

      if (headSha && headSha !== loopBefore.currentHeadSha) {
        // Update currentHeadSha and bump loopVersion directly — this
        // simulates the agent having pushed new code without going through
        // the full review_gate→implementing→review_gate cycle which would
        // double-count fix attempts.
        const ver = await freshLoopVersion(
          db,
          shared,
          seeded.loopId,
          loopVersion,
        );
        const nextVer = ver + 1;
        await db
          .update(shared.schema.sdlcLoop)
          .set({
            currentHeadSha: headSha,
            loopVersion: nextVer,
            updatedAt: new Date(),
          })
          .where((shared.eq as any)(shared.schema.sdlcLoop.id, seeded.loopId));

        setTransitionEvent("review_gate_redispatch");

        // Replay gate events for the new headSha
        if (gateEvents.length > 0) {
          await replayGateEvents({
            db,
            shared,
            loopId: seeded.loopId,
            headSha,
            gateEvents,
            fallbackLoopVersion: nextVer,
          });
        }
      } else if (headSha && gateEvents.length > 0) {
        // Same headSha as before — just replay gate events
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
    return;
  }

  // ── Review signals ──
  if (
    causeType === "pull_request_review" ||
    causeType === "pull_request_review_comment"
  ) {
    // If this signal references a headSha with unreplayed gate events,
    // replay them — covers the case where a daemon_terminal for this
    // headSha was not captured in the fixture.
    const headSha = getPayloadText(signal.payload, "headSha") || "";
    if (
      headSha &&
      headSha !== loopBefore.currentHeadSha &&
      gateEvents.length > 0
    ) {
      const hasGates = gateEvents.some((e) => e.headSha === headSha);
      if (hasGates) {
        // Update currentHeadSha and bump loopVersion
        const ver = await freshLoopVersion(
          db,
          shared,
          seeded.loopId,
          loopVersion,
        );
        const nextVer = ver + 1;

        // Transition implementing → review_gate if needed
        if (previousState === "implementing") {
          await shared.transitionSdlcLoopState({
            db,
            loopId: seeded.loopId,
            transitionEvent: "implementation_completed" as any,
            headSha,
            loopVersion: nextVer,
          });
        } else {
          await db
            .update(shared.schema.sdlcLoop)
            .set({
              currentHeadSha: headSha,
              loopVersion: nextVer,
              updatedAt: new Date(),
            })
            .where(
              (shared.eq as any)(shared.schema.sdlcLoop.id, seeded.loopId),
            );
        }

        await replayGateEvents({
          db,
          shared,
          loopId: seeded.loopId,
          headSha,
          gateEvents,
          fallbackLoopVersion: nextVer,
        });
      }
    }
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

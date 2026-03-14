import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";
import type { SdlcCiRequiredCheckSource, SdlcLoopState } from "../../db/types";
import type { DeliveryLoopState, DeliveryLoopResumableState } from "./types";
import {
  assertNever,
  coerceDeliveryLoopResumableState,
  buildPersistedDeliveryLoopSnapshot,
  buildDeliveryLoopCompanionFields,
  DELIVERY_LOOP_CANONICAL_STATE_SET,
} from "./types";
import type {
  DeliveryLoopTransitionEvent,
  DeliveryLoopTransitionResult,
} from "./state-machine";
import { reducePersistedDeliveryLoopState } from "./state-machine";
import type { SdlcLoopTransitionEvent } from "./state-constants";
import {
  activeSdlcLoopStateList,
  activeSdlcLoopStateSet,
} from "./state-constants";

function normalizeCheckNames(checks: string[]): string[] {
  return [...new Set(checks.map((check) => check.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

function resolveRequiredCheckSource({
  rulesetChecks,
  branchProtectionChecks,
  allowlistChecks,
}: {
  rulesetChecks: string[];
  branchProtectionChecks: string[];
  allowlistChecks: string[];
}): {
  source: SdlcCiRequiredCheckSource;
  requiredChecks: string[];
} {
  if (rulesetChecks.length > 0) {
    return { source: "ruleset", requiredChecks: rulesetChecks };
  }
  if (branchProtectionChecks.length > 0) {
    return {
      source: "branch_protection",
      requiredChecks: branchProtectionChecks,
    };
  }
  if (allowlistChecks.length > 0) {
    return { source: "allowlist", requiredChecks: allowlistChecks };
  }
  return { source: "no_required", requiredChecks: [] };
}

export type StaleNoopReason =
  | "loop_not_found"
  | "state_not_canonical"
  | "transition_unmapped"
  | "transition_invalid"
  | "version_conflict"
  | "headsha_conflict"
  | "where_guard_miss"
  | "wrong_state_for_event";

export type SdlcGateLoopUpdateOutcome =
  | "updated"
  | "terminal_noop"
  | { staleReason: StaleNoopReason };

export function isStaleNoop(
  outcome: SdlcGateLoopUpdateOutcome,
): outcome is { staleReason: StaleNoopReason } {
  return (
    typeof outcome === "object" && outcome !== null && "staleReason" in outcome
  );
}

export const fixAttemptIncrementEvents: ReadonlySet<SdlcLoopTransitionEvent> =
  new Set([
    "plan_gate_blocked",
    "implementation_gate_blocked",
    "review_blocked",
    "ui_smoke_failed",
    "babysit_blocked",
    // Legacy gate-blocked events still increment attempts during migration.
    "ci_gate_blocked",
    "review_threads_gate_blocked",
    "deep_review_gate_blocked",
    "carmack_review_gate_blocked",
  ]);

function shouldResetFixAttemptCountOnTransition({
  previousState,
  nextState,
}: {
  previousState: SdlcLoopState;
  nextState: SdlcLoopState;
}): boolean {
  if (previousState === nextState || nextState === "blocked") {
    return false;
  }
  if (previousState === "planning" && nextState === "implementing") {
    return true;
  }
  if (previousState === "implementing" && nextState === "review_gate") {
    // This is a fix-cycle return, not genuine phase advancement.
    // Resetting here prevents maxFixAttempts from ever triggering.
    return false;
  }
  if (previousState === "review_gate" && nextState === "ci_gate") {
    return true;
  }
  if (previousState === "ci_gate" && nextState === "ui_gate") {
    return true;
  }
  if (previousState === "ui_gate" && nextState === "awaiting_pr_link") {
    return true;
  }
  if (previousState === "ui_gate" && nextState === "babysitting") {
    return true;
  }
  if (previousState === "awaiting_pr_link" && nextState === "babysitting") {
    return true;
  }
  return false;
}

type CanonicalWriteTransitionEvent = DeliveryLoopTransitionEvent | "noop";

function mapSdlcTransitionEventToCanonicalWriteTransition(params: {
  event: SdlcLoopTransitionEvent;
  currentState: SdlcLoopState;
  hasPrLink: boolean;
}): CanonicalWriteTransitionEvent | null {
  switch (params.event) {
    case "plan_completed":
      return "plan_completed";
    case "plan_gate_blocked":
      return "plan_gate_blocked";
    case "implementation_completed":
      return "implementation_completed";
    case "implementation_gate_blocked":
      return "implementation_gate_blocked";
    case "review_passed":
      return "review_gate_passed";
    case "review_blocked":
      return "review_gate_blocked";
    case "ci_gate_passed":
      return params.currentState === "babysitting" ? "noop" : "ci_gate_passed";
    case "ci_gate_blocked":
      return params.currentState === "babysitting"
        ? "babysit_blocked"
        : "ci_gate_blocked";
    case "ui_smoke_passed":
    case "video_capture_succeeded":
      return params.hasPrLink
        ? "ui_gate_passed_with_pr"
        : "ui_gate_passed_without_pr";
    case "ui_smoke_failed":
    case "video_capture_failed":
      return "ui_gate_blocked";
    case "pr_linked":
      return "pr_linked";
    case "babysit_passed":
      return "babysit_passed";
    case "babysit_blocked":
      return "babysit_blocked";
    case "human_feedback_requested":
      return "exhausted_retryable_failure";
    case "blocked_resume_requested":
    case "blocked_bypass_once_requested":
      return "blocked_resume";
    case "manual_stop":
      return "manual_stop";
    case "pr_closed_unmerged":
      return "pr_closed_unmerged";
    case "pr_merged":
      return "pr_merged";
    case "mark_done":
      return "mark_done";
    case "review_threads_gate_blocked":
      return params.currentState === "babysitting"
        ? "babysit_blocked"
        : "ci_gate_blocked";
    case "review_threads_gate_passed":
      return params.currentState === "babysitting" ? "noop" : "ci_gate_passed";
    case "deep_review_gate_blocked":
    case "carmack_review_gate_blocked":
      return params.currentState === "babysitting"
        ? "babysit_blocked"
        : "review_gate_blocked";
    case "deep_review_gate_passed":
    case "carmack_review_gate_passed":
      return params.currentState === "review_gate" ||
        params.currentState === "babysitting"
        ? "noop"
        : null;
    case "implementation_progress":
      if (params.currentState === "blocked") {
        return "blocked_resume";
      }
      if (params.currentState === "implementing") {
        return "noop";
      }
      return null;
    case "video_capture_started":
      return params.currentState === "ui_gate" ? "noop" : null;
  }
  return assertNever(params.event);
}

export async function persistGuardedGateLoopState({
  tx,
  loopId,
  transitionEvent,
  headSha,
  loopVersion,
  blockedFromState,
  now = new Date(),
}: {
  tx: Pick<DB, "query" | "update">;
  loopId: string;
  transitionEvent: SdlcLoopTransitionEvent;
  headSha?: string | null;
  loopVersion?: number;
  blockedFromState?: DeliveryLoopResumableState | null;
  now?: Date;
}): Promise<SdlcGateLoopUpdateOutcome> {
  const loop = await tx.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.id, loopId),
    columns: {
      state: true,
      loopVersion: true,
      currentHeadSha: true,
      fixAttemptCount: true,
      maxFixAttempts: true,
      blockedFromState: true,
      phaseEnteredAt: true,
      prNumber: true,
    },
  });

  if (!loop) {
    return { staleReason: "loop_not_found" };
  }

  if (!activeSdlcLoopStateSet.has(loop.state)) {
    return "terminal_noop";
  }

  const normalizedLoopVersion =
    typeof loopVersion === "number" && Number.isFinite(loopVersion)
      ? Math.max(Math.trunc(loopVersion), 0)
      : null;
  if (
    transitionEvent === "implementation_progress" &&
    normalizedLoopVersion === null &&
    loop.state !== "planning" &&
    loop.state !== "implementing"
  ) {
    return { staleReason: "wrong_state_for_event" };
  }
  if (!DELIVERY_LOOP_CANONICAL_STATE_SET.has(loop.state as DeliveryLoopState)) {
    return { staleReason: "state_not_canonical" };
  }

  const persistedBlockedFromState = coerceDeliveryLoopResumableState(
    loop.blockedFromState,
  );
  const canonicalTransitionEvent =
    mapSdlcTransitionEventToCanonicalWriteTransition({
      event: transitionEvent,
      currentState: loop.state,
      hasPrLink:
        typeof loop.prNumber === "number" && Number.isFinite(loop.prNumber),
    });
  if (!canonicalTransitionEvent) {
    return { staleReason: "transition_unmapped" };
  }

  let reducedTransition: DeliveryLoopTransitionResult | null =
    canonicalTransitionEvent === "noop"
      ? {
          state: loop.state as DeliveryLoopState,
          snapshot: buildPersistedDeliveryLoopSnapshot({
            state: loop.state as DeliveryLoopState,
            blockedFromState: blockedFromState ?? persistedBlockedFromState,
          }),
          companionFields: buildDeliveryLoopCompanionFields(
            buildPersistedDeliveryLoopSnapshot({
              state: loop.state as DeliveryLoopState,
              blockedFromState: blockedFromState ?? persistedBlockedFromState,
            }),
          ),
        }
      : reducePersistedDeliveryLoopState({
          state: loop.state as DeliveryLoopState,
          blockedFromState: blockedFromState ?? persistedBlockedFromState,
          event: canonicalTransitionEvent,
        });
  let nextState =
    canonicalTransitionEvent === "noop"
      ? (loop.state as DeliveryLoopState)
      : (reducedTransition?.state ?? null);

  if (!nextState) {
    return { staleReason: "transition_invalid" };
  }

  const shouldIncrementFixAttempt =
    fixAttemptIncrementEvents.has(transitionEvent);
  const incrementedFixAttemptCount = shouldIncrementFixAttempt
    ? loop.fixAttemptCount + 1
    : loop.fixAttemptCount;
  const exhaustedRetryBudget =
    shouldIncrementFixAttempt &&
    incrementedFixAttemptCount > Math.max(loop.maxFixAttempts, 0);
  if (exhaustedRetryBudget) {
    reducedTransition = reducePersistedDeliveryLoopState({
      state: loop.state as DeliveryLoopState,
      blockedFromState: blockedFromState ?? persistedBlockedFromState,
      event: "exhausted_retryable_failure",
    });
    nextState = reducedTransition?.state ?? "blocked";
  }

  if (normalizedLoopVersion !== null) {
    if (loop.loopVersion > normalizedLoopVersion) {
      return { staleReason: "version_conflict" };
    }

    if (
      typeof headSha === "string" &&
      loop.loopVersion === normalizedLoopVersion &&
      loop.currentHeadSha !== null &&
      loop.currentHeadSha !== headSha
    ) {
      return { staleReason: "headsha_conflict" };
    }
  }

  const nextValues: {
    state: SdlcLoopState;
    updatedAt: Date;
    currentHeadSha?: string | null;
    loopVersion?: number;
    fixAttemptCount?: number;
    blockedFromState?: SdlcLoopState | null;
    phaseEnteredAt?: Date | null;
  } = {
    state: nextState,
    updatedAt: now,
  };
  const nextBlockedFromState =
    nextState === "blocked"
      ? reducedTransition?.snapshot.kind === "blocked"
        ? reducedTransition.snapshot.from
        : (blockedFromState ??
          persistedBlockedFromState ??
          coerceDeliveryLoopResumableState(loop.state) ??
          "implementing")
      : null;
  if (nextBlockedFromState !== (loop.blockedFromState ?? null)) {
    nextValues.blockedFromState = nextBlockedFromState;
  }
  if (shouldIncrementFixAttempt) {
    nextValues.fixAttemptCount = incrementedFixAttemptCount;
  }
  if (
    normalizedLoopVersion !== null &&
    (typeof headSha === "string" || headSha === null)
  ) {
    nextValues.currentHeadSha = headSha;
  }
  if (normalizedLoopVersion !== null) {
    nextValues.loopVersion = normalizedLoopVersion;
  }
  if (nextState !== loop.state) {
    nextValues.phaseEnteredAt = now;
    if (
      shouldResetFixAttemptCountOnTransition({
        previousState: loop.state,
        nextState,
      })
    ) {
      nextValues.fixAttemptCount = 0;
    }
  }

  let whereCondition = and(
    eq(schema.sdlcLoop.id, loopId),
    eq(schema.sdlcLoop.state, loop.state),
    inArray(schema.sdlcLoop.state, activeSdlcLoopStateList),
  );

  if (normalizedLoopVersion !== null && whereCondition) {
    whereCondition = and(
      whereCondition,
      lte(schema.sdlcLoop.loopVersion, normalizedLoopVersion),
    );
    if (typeof headSha === "string" && whereCondition) {
      const headShaGuard = or(
        lte(schema.sdlcLoop.loopVersion, normalizedLoopVersion - 1),
        isNull(schema.sdlcLoop.currentHeadSha),
        eq(schema.sdlcLoop.currentHeadSha, headSha),
      );
      if (headShaGuard) {
        whereCondition = and(whereCondition, headShaGuard);
      }
    }
  }

  if (!whereCondition) {
    return { staleReason: "where_guard_miss" };
  }

  const [updated] = await tx
    .update(schema.sdlcLoop)
    .set(nextValues)
    .where(whereCondition)
    .returning({ id: schema.sdlcLoop.id });

  return updated ? "updated" : { staleReason: "where_guard_miss" };
}

export async function transitionSdlcLoopState({
  db,
  loopId,
  transitionEvent,
  headSha,
  loopVersion,
  blockedFromState,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  transitionEvent: SdlcLoopTransitionEvent;
  headSha?: string | null;
  loopVersion?: number;
  blockedFromState?: DeliveryLoopResumableState | null;
  now?: Date;
}): Promise<SdlcGateLoopUpdateOutcome> {
  return await db.transaction(async (tx) => {
    return await persistGuardedGateLoopState({
      tx,
      loopId,
      transitionEvent,
      headSha,
      loopVersion,
      blockedFromState,
      now,
    });
  });
}

export { normalizeCheckNames, resolveRequiredCheckSource };

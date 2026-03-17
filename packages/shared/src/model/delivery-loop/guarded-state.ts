import type { SdlcCiRequiredCheckSource } from "../../db/types";
import type { SdlcLoopTransitionEvent } from "./state-constants";

export function normalizeCheckNames(checks: string[]): string[] {
  return [...new Set(checks.map((check) => check.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

export function resolveRequiredCheckSource({
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
    "ci_gate_blocked",
    "review_threads_gate_blocked",
    "deep_review_gate_blocked",
    "carmack_review_gate_blocked",
  ]);

// ---------------------------------------------------------------------------
// persistGuardedGateLoopState and transitionSdlcLoopState have been removed.
// They operated on the now-deleted sdlcLoop table. Use the v2 delivery
// workflow store for state transitions.
// ---------------------------------------------------------------------------

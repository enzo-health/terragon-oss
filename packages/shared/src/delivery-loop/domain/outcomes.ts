/**
 * Outcome types — typed, ingress-specific results that preserve metadata
 * from the raw event source. Outcomes flow alongside the existing signal
 * shape without changing it; they capture envelope context, error
 * classification, and provenance that signals intentionally discard.
 */

import type { DeliveryLoopFailureCategory } from "./failure";
import type { DaemonCompletionResult } from "./signals";

// ── Daemon terminal error classification ─────────────────────────────
// Moved from apps/www/src/app/api/daemon-event/route.ts — pure functions
// with no Next.js dependencies.

export type DaemonTerminalErrorCategory =
  | "provider_not_configured"
  | "acp_sse_not_found"
  | "daemon_custom_error"
  | "daemon_result_error"
  | "unknown";

export function classifyDaemonTerminalErrorCategory(
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

export function mapDaemonTerminalCategoryToFailureCategory(
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

// ── Envelope context ─────────────────────────────────────────────────

/** Shared context from the daemon's v2 event envelope. */
export type DaemonEnvelopeContext = {
  eventId: string;
  seq: number;
  runId: string;
  contextUsage: number | null;
};

// ── Daemon outcomes ──────────────────────────────────────────────────

export type DaemonOutcome =
  | {
      kind: "completion";
      envelope: DaemonEnvelopeContext;
      result: DaemonCompletionResult;
      headSha: string | null;
      summary: string | null;
    }
  | {
      kind: "failure";
      envelope: DaemonEnvelopeContext;
      errorMessage: string | null;
      errorCategory: DaemonTerminalErrorCategory;
      failureCategory: DeliveryLoopFailureCategory;
      exitCode: number | null;
    }
  | {
      kind: "user_stop";
      envelope: DaemonEnvelopeContext;
    }
  | {
      kind: "progress";
      envelope: DaemonEnvelopeContext;
      completedTasks: number;
      totalTasks: number;
      currentTask: string | null;
    };

// ── Other ingress outcome stubs ──────────────────────────────────────

/** Outcome for GitHub webhook events (PR status, checks, reviews). */
export type GitHubOutcome =
  | { kind: "ci_changed"; prNumber: number; passed: boolean }
  | { kind: "review_changed"; prNumber: number; passed: boolean }
  | { kind: "pr_closed"; prNumber: number; merged: boolean }
  | { kind: "pr_synchronized"; prNumber: number; headSha: string };

/** Outcome for human-initiated signals (approve, reject, stop). */
export type HumanOutcome =
  | { kind: "resume"; actorUserId: string }
  | { kind: "stop"; actorUserId: string }
  | { kind: "mark_done"; actorUserId: string }
  | { kind: "plan_approved"; artifactId: string }
  | { kind: "bypass_gate"; actorUserId: string; gate: string };

/** Outcome for timer/timeout events. */
export type TimerOutcome =
  | { kind: "dispatch_ack_expired"; dispatchId: string }
  | { kind: "babysit_due" }
  | { kind: "heartbeat_check" };

/** Outcome for babysit worker events. */
export type BabysitOutcome =
  | { kind: "gates_passed"; headSha: string }
  | { kind: "gates_blocked"; headSha: string };

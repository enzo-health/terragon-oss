import type { DeliverySignal } from "@terragon/shared/delivery-loop/domain/signals";
import type { DaemonSignal } from "@terragon/shared/delivery-loop/domain/signals";
import type { GitHubSignal } from "@terragon/shared/delivery-loop/domain/signals";
import type { HumanSignal } from "@terragon/shared/delivery-loop/domain/signals";
import type { TimerSignal } from "@terragon/shared/delivery-loop/domain/signals";
import type { BabysitSignal } from "@terragon/shared/delivery-loop/domain/signals";

const VALID_SIGNAL_SOURCES: ReadonlySet<string> = new Set([
  "daemon",
  "github",
  "human",
  "timer",
  "babysit",
]);

export type ParseResult =
  | DeliverySignal
  | { retryable: true; reason: string }
  | null;

/**
 * Translate a signal-inbox row (causeType + payload) into a typed
 * DeliverySignal discriminated union the coordinator can feed into
 * the reducer.
 *
 * V2 signals arrive with `{ source, event }` shape and pass through
 * directly. The remaining branches map v2 causeType strings that
 * carry a flat payload (no source/event wrapper) into the same shape.
 */
export function parseSignalPayload(
  causeType: string,
  payload: Record<string, unknown> | null,
): ParseResult {
  if (!payload) return null;

  const source = payload.source as string | undefined;
  const event = payload.event as Record<string, unknown> | undefined;

  if (source && event) {
    // Already in v2 shape — validate and pass through
    if (!VALID_SIGNAL_SOURCES.has(source)) return null;
    if (typeof event.kind !== "string") return null;
    return payload as unknown as DeliverySignal;
  }

  // Map v2 causeType strings to the typed signal union
  switch (causeType) {
    case "daemon_run_completed":
    case "daemon_run_failed":
    case "daemon_progress":
      return {
        source: "daemon",
        event: payload as unknown as DaemonSignal,
      };
    case "github_ci_changed":
    case "github_review_changed":
    case "github_pr_closed":
    case "github_pr_synchronized":
      return {
        source: "github",
        event: payload as unknown as GitHubSignal,
      };
    case "human_resume":
    case "human_bypass":
    case "human_stop":
    case "human_mark_done":
    case "human_operator_action_required":
      return {
        source: "human",
        event: payload as unknown as HumanSignal,
      };
    case "timer_dispatch_ack_expired":
    case "timer_babysit_due":
    case "timer_heartbeat":
      return {
        source: "timer",
        event: payload as unknown as TimerSignal,
      };
    case "babysit_recheck_blocked":
    case "babysit_recheck_passed":
      return {
        source: "babysit",
        event: payload as unknown as BabysitSignal,
      };

    default:
      return null;
  }
}

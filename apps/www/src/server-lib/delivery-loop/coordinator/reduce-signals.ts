import type {
  DeliverySignal,
  DaemonSignal,
  DaemonFailure,
  GitHubSignal,
  HumanSignal,
  TimerSignal,
  BabysitSignal,
} from "@terragon/shared/delivery-loop/domain/signals";
import type {
  DeliveryWorkflow,
  GateKind,
} from "@terragon/shared/delivery-loop/domain/workflow";
import { isActiveState } from "@terragon/shared/delivery-loop/domain/workflow";
import type {
  LoopEvent,
  LoopEventContext,
  GateVerdict,
} from "@terragon/shared/delivery-loop/domain/events";

export type SignalReductionResult =
  | { event: LoopEvent; context: LoopEventContext }
  | { retryable: true; reason: string }
  | null;

export function reduceSignalToEvent(params: {
  signal: DeliverySignal;
  workflow: DeliveryWorkflow;
  gateVerdicts?: GateVerdict[];
  prNumber?: number | null;
}): SignalReductionResult {
  let result: SignalReductionResult;
  switch (params.signal.source) {
    case "daemon":
      result = reduceDaemonSignal(params.signal.event, params.workflow);
      break;
    case "github":
      result = reduceGitHubSignal(
        params.signal.event,
        params.workflow,
        params.gateVerdicts,
      );
      break;
    case "human":
      result = reduceHumanSignal(params.signal.event, params.workflow);
      break;
    case "timer":
      result = reduceTimerSignal(params.signal.event, params.workflow);
      break;
    case "babysit":
      result = reduceBabysitSignal(params.signal.event, params.workflow);
      break;
  }

  // Enrich gate_passed events with PR link info so the reducer
  // can decide between babysitting (has PR) and awaiting_pr (no PR).
  if (
    result &&
    "event" in result &&
    result.event === "gate_passed" &&
    params.prNumber != null
  ) {
    result.context = {
      ...result.context,
      hasPrLink: true,
      prNumber: params.prNumber,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Daemon signals
// ---------------------------------------------------------------------------

function reduceDaemonSignal(
  event: DaemonSignal,
  workflow: DeliveryWorkflow,
): SignalReductionResult {
  switch (event.kind) {
    case "run_completed":
      if (workflow.kind === "planning") {
        return { event: "plan_completed", context: {} };
      }
      if (workflow.kind === "implementing") {
        if (event.result.kind === "partial") {
          // Partial completion — stay in implementing for re-dispatch
          // without incrementing fixAttemptCount (normal multi-pass).
          return { event: "redispatch_requested", context: {} };
        }
        // The daemon only emits run_completed after the checkpoint pipeline
        // (deep review, carmack review, quality check, UI smoke) has passed.
        // Internal gates are pre-conditions enforced by checkpoint-thread-
        // internal.ts, not post-conditions for the v2 coordinator.
        return {
          event: "implementation_completed",
          context: { headSha: event.result.headSha },
        };
      }
      return null;

    case "run_failed":
      if (workflow.kind === "implementing") {
        // Infrastructure failures (e.g. ACP transient "Internal error" during
        // sandbox-agent startup) should NOT consume the fix-attempt budget.
        // Re-dispatch without penalty, up to a separate infra retry limit.
        if (isInfrastructureFailure(event.failure)) {
          const MAX_INFRA_RETRIES = 10;
          if (workflow.infraRetryCount >= MAX_INFRA_RETRIES) {
            return { event: "exhausted_retries", context: {} };
          }
          return {
            event: "redispatch_requested",
            context: { infraRetry: true },
          };
        }

        // Budget check — if at or past max, escalate to manual fix
        if (workflow.fixAttemptCount >= workflow.maxFixAttempts - 1) {
          return { event: "exhausted_retries", context: {} };
        }
        // Classify by failure kind
        switch (event.failure.kind) {
          case "runtime_crash":
          case "timeout":
          case "oom":
            // Transient-ish failures — let the state machine retry via gate_blocked
            return { event: "gate_blocked", context: {} };
          case "config_error":
            return { event: "exhausted_retries", context: {} };
        }
      }
      if (workflow.kind === "gating") {
        // Gate runtime dispatch crashed — send back to implementing for a fix cycle
        return { event: "gate_blocked", context: {} };
      }
      return null;

    case "progress_reported":
      // No state transition — observability only
      return null;

    case "gate_completed":
      if (workflow.kind === "gating") {
        return {
          event: event.passed ? "gate_passed" : "gate_blocked",
          context: { gate: event.gate, headSha: event.headSha },
        };
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// GitHub signals
// ---------------------------------------------------------------------------

function reduceGitHubSignal(
  event: GitHubSignal,
  workflow: DeliveryWorkflow,
  gateVerdicts?: GateVerdict[],
): SignalReductionResult {
  switch (event.kind) {
    case "ci_changed":
      return reduceGateSignal({
        gate: "ci",
        headSha: event.headSha,
        workflow,
        gateVerdicts,
        evaluateInGate: () => {
          // Use the aggregate CI snapshot: only pass when failingChecks is
          // empty AND there are required checks. A single passing check_run
          // must not advance the gate while other required checks are pending.
          if (event.result.requiredChecks.length === 0) {
            // No check data — cannot determine pass/fail. Mark retryable so
            // the signal stays pending for the next webhook or cron catch-up
            // instead of being consumed as a no-op.
            return {
              retryable: true,
              reason: "CI signal has no required checks data",
            };
          }
          const aggregatePassed = event.result.failingChecks.length === 0;
          return {
            event: aggregatePassed ? "gate_passed" : "gate_blocked",
            context: { gate: "ci" },
          };
        },
      });

    case "review_changed":
      return reduceGateSignal({
        gate: "review",
        headSha: event.headSha,
        workflow,
        gateVerdicts,
        evaluateInGate: () => ({
          event: event.result.passed ? "gate_passed" : "gate_blocked",
          context: { gate: "review" },
        }),
      });

    case "pr_closed":
      return {
        event: event.merged ? "pr_merged" : "pr_closed",
        context: {},
      };

    case "pr_synchronized":
      // When the workflow is waiting for a PR link, treat a synchronized
      // event as the signal that the PR was just linked.
      if (workflow.kind === "awaiting_pr") {
        return { event: "pr_linked", context: { prNumber: event.prNumber } };
      }
      // Otherwise — head SHA update only, no state transition
      return null;
  }
}

// ---------------------------------------------------------------------------
// Human signals
// ---------------------------------------------------------------------------

function reduceHumanSignal(
  event: HumanSignal,
  _workflow: DeliveryWorkflow,
): SignalReductionResult {
  switch (event.kind) {
    case "resume_requested":
      return { event: "blocked_resume", context: {} };
    case "bypass_requested":
      return { event: "gate_passed", context: { gate: event.target } };
    case "stop_requested":
      return { event: "manual_stop", context: {} };
    case "mark_done_requested":
      return { event: "mark_done", context: {} };
    case "plan_approved":
      return { event: "plan_completed", context: {} };
  }
}

// ---------------------------------------------------------------------------
// Timer signals
// ---------------------------------------------------------------------------

function reduceTimerSignal(
  event: TimerSignal,
  workflow: DeliveryWorkflow,
): SignalReductionResult {
  switch (event.kind) {
    case "dispatch_ack_expired": {
      // Infrastructure timeouts (dispatch never acked) should NOT consume
      // the fix-attempt budget meant for agent-level failures. Use a
      // separate inline limit based on consecutive ack failures.
      const MAX_DISPATCH_ACK_RETRIES = 5;
      const ackFailures = event.consecutiveFailures ?? 1;
      if (ackFailures >= MAX_DISPATCH_ACK_RETRIES) {
        return { event: "exhausted_retries", context: {} };
      }
      // gate_blocked re-triggers dispatch in implementing/gating; for
      // planning it bumps the version so schedule-work re-enqueues dispatch.
      return { event: "gate_blocked", context: {} };
    }

    case "babysit_due":
      // The actual babysit check happens asynchronously via work items.
      // At signal level, we just note that a recheck is due — the caller
      // determines pass/fail from the work item result.
      return null;

    case "heartbeat_check":
      // Observability only
      return null;
  }
}

// ---------------------------------------------------------------------------
// Babysit signals
// ---------------------------------------------------------------------------

function reduceBabysitSignal(
  event: BabysitSignal,
  workflow: DeliveryWorkflow,
): SignalReductionResult {
  switch (event.kind) {
    case "babysit_gates_passed":
      if (workflow.kind === "babysitting") {
        return { event: "babysit_passed", context: {} };
      }
      return null;
    case "babysit_gates_blocked":
      if (workflow.kind === "babysitting") {
        return { event: "babysit_blocked", context: {} };
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shared gate signal handler
// ---------------------------------------------------------------------------

/**
 * Common logic for ci_changed / review_changed signals:
 * stale-signal rejection → verdict check → gate-specific evaluation →
 * babysitting deferral → active-state deferral.
 */
function reduceGateSignal(params: {
  gate: GateKind;
  headSha: string | undefined;
  workflow: DeliveryWorkflow;
  gateVerdicts?: GateVerdict[];
  /** Gate-specific pass/fail evaluation when the workflow is in the matching gate. */
  evaluateInGate: () => SignalReductionResult;
}): SignalReductionResult {
  const { gate, headSha, workflow, gateVerdicts, evaluateInGate } = params;

  // Stale-signal rejection: if the signal carries a headSha that doesn't
  // match the workflow's current head, the signal is outdated.
  if (
    headSha &&
    workflow.kind === "gating" &&
    "headSha" in workflow &&
    workflow.headSha !== headSha
  ) {
    return null;
  }

  // Check pre-computed verdicts first
  const verdict = gateVerdicts?.find((v) => v.gate === gate);
  if (verdict) {
    return {
      event: verdict.passed ? "gate_passed" : "gate_blocked",
      context: { gate },
    };
  }

  // Gate-specific evaluation when in the matching gating substate
  if (workflow.kind === "gating" && workflow.gate.kind === gate) {
    return evaluateInGate();
  }

  // In babysitting, gate signals trigger a babysit recheck
  if (workflow.kind === "babysitting") {
    return {
      retryable: true,
      reason: `${gate} signal in babysitting — awaiting babysit worker recheck`,
    };
  }

  // In other active states, keep the signal pending for when the
  // workflow reaches the matching gate.
  if (isActiveState(workflow.kind)) {
    return {
      retryable: true,
      reason: `${gate} signal received while workflow is ${workflow.kind}, not in ${gate} gate`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Infrastructure failure detection
// ---------------------------------------------------------------------------

/**
 * Identifies transient infrastructure failures (e.g. ACP startup race condition
 * where sandbox-agent isn't ready and Claude Agent SDK returns "Internal error").
 * These should not consume the fix-attempt budget.
 */
function isInfrastructureFailure(failure: DaemonFailure): boolean {
  return (
    failure.kind === "runtime_crash" && failure.message === "Internal error"
  );
}

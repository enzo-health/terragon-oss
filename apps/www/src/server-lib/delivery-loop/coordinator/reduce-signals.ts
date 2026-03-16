import type {
  DeliverySignal,
  DaemonSignal,
  GitHubSignal,
  HumanSignal,
  TimerSignal,
  BabysitSignal,
} from "@terragon/shared/delivery-loop/domain/signals";
import type { DeliveryWorkflow } from "@terragon/shared/delivery-loop/domain/workflow";
import type {
  LoopEvent,
  LoopEventContext,
  GateVerdict,
} from "@terragon/shared/delivery-loop/domain/events";

export type SignalReductionResult = {
  event: LoopEvent;
  context: LoopEventContext;
} | null;

export function reduceSignalToEvent(params: {
  signal: DeliverySignal;
  workflow: DeliveryWorkflow;
  gateVerdicts?: GateVerdict[];
}): SignalReductionResult {
  switch (params.signal.source) {
    case "daemon":
      return reduceDaemonSignal(params.signal.event, params.workflow);
    case "github":
      return reduceGitHubSignal(
        params.signal.event,
        params.workflow,
        params.gateVerdicts,
      );
    case "human":
      return reduceHumanSignal(params.signal.event, params.workflow);
    case "timer":
      return reduceTimerSignal(params.signal.event, params.workflow);
    case "babysit":
      return reduceBabysitSignal(params.signal.event, params.workflow);
  }
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
        // Daemon finished a planning run. Plan validation/promotion is
        // handled by the v1 checkpoint pipeline (promote-plan.ts) which
        // bridges into v2 via v1 loop state transition. Do NOT auto-advance
        // the v2 workflow here — the plan may not have parsed or may
        // require human approval.
        return null;
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
      return null;

    case "progress_reported":
      // No state transition — observability only
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
    case "ci_changed": {
      // Check verdicts first if provided
      const verdict = gateVerdicts?.find((v) => v.gate === "ci");
      if (verdict) {
        return {
          event: verdict.passed ? "gate_passed" : "gate_blocked",
          context: { gate: "ci" },
        };
      }
      // Use the aggregate CI snapshot: only pass when failingChecks is
      // empty AND there are required checks. A single passing check_run
      // must not advance the gate while other required checks are pending.
      if (workflow.kind === "gating" && workflow.gate.kind === "ci") {
        const aggregatePassed =
          event.result.failingChecks.length === 0 &&
          event.result.requiredChecks.length > 0;
        return {
          event: aggregatePassed ? "gate_passed" : "gate_blocked",
          context: { gate: "ci" },
        };
      }
      // In babysitting, raw GitHub signals are suppressed — only the
      // babysit worker's aggregate evaluation produces transitions.
      return null;
    }

    case "review_changed": {
      const verdict = gateVerdicts?.find((v) => v.gate === "review");
      if (verdict) {
        return {
          event: verdict.passed ? "gate_passed" : "gate_blocked",
          context: { gate: "review" },
        };
      }
      if (workflow.kind === "gating" && workflow.gate.kind === "review") {
        return {
          event: event.result.passed ? "gate_passed" : "gate_blocked",
          context: { gate: "review" },
        };
      }
      // In babysitting, raw GitHub signals are suppressed — only the
      // babysit worker's aggregate evaluation produces transitions.
      return null;
    }

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
    case "dispatch_ack_expired":
      if (
        workflow.kind === "implementing" &&
        workflow.fixAttemptCount >= workflow.maxFixAttempts - 1
      ) {
        return { event: "exhausted_retries", context: {} };
      }
      // Re-enter implementing for retry (gate_blocked triggers re-dispatch)
      return { event: "gate_blocked", context: {} };

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

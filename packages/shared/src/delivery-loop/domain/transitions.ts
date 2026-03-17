import type {
  DeliveryWorkflow,
  WorkflowCommon,
  PendingAction,
  GateKind,
  PlanVersion,
  DispatchSubState,
  GateSubState,
  ManualFixIssue,
  ResumableWorkflowState,
} from "./workflow";
import type { LoopEvent, LoopEventContext } from "./events";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bump(wf: DeliveryWorkflow, now: Date): WorkflowCommon {
  return {
    workflowId: wf.workflowId,
    threadId: wf.threadId,
    generation: wf.generation,
    version: wf.version + 1,
    fixAttemptCount: wf.fixAttemptCount,
    maxFixAttempts: wf.maxFixAttempts,
    createdAt: wf.createdAt,
    updatedAt: now,
    lastActivityAt: now,
  };
}

function bumpWithFixReset(
  wf: DeliveryWorkflow,
  event: LoopEvent,
  ctx: LoopEventContext,
  now: Date,
): WorkflowCommon {
  const base = bump(wf, now);
  if (shouldResetFixAttemptCount(event, ctx)) {
    return { ...base, fixAttemptCount: 0 };
  }
  return base;
}

const NEXT_GATE: Record<GateKind, GateKind | null> = {
  review: "ci",
  ci: "ui",
  ui: null,
};

function emptyGateSubState(gate: GateKind): GateSubState {
  switch (gate) {
    case "review":
      return {
        kind: "review",
        status: "waiting",
        runId: null,
        snapshot: {
          requiredApprovals: 0,
          approvalsReceived: 0,
          blockers: [],
        },
      };
    case "ci":
      return {
        kind: "ci",
        status: "waiting",
        runId: null,
        snapshot: { checkSuites: [], failingRequiredChecks: [] },
      };
    case "ui":
      return {
        kind: "ui",
        status: "waiting",
        runId: null,
        snapshot: { artifactUrl: null, blockers: [] },
      };
  }
}

// Default dispatch for re-entering implementing
function defaultQueuedDispatch(wf: DeliveryWorkflow): DispatchSubState {
  return {
    kind: "queued",
    dispatchId: `d-retry-${wf.version}` as DeliveryWorkflow extends never
      ? never
      : import("./workflow").DispatchId,
    executionClass: "implementation_runtime",
  };
}

/**
 * Shared helper: re-enter implementing for a fix attempt.
 * Increments fixAttemptCount, preserves planVersion when available
 * on the source state (implementing carries it; gating/babysitting don't).
 */
function retryToImplementing(
  wf: DeliveryWorkflow,
  now: Date,
): DeliveryWorkflow {
  const base = bump(wf, now);
  const planVersion =
    "planVersion" in wf && wf.planVersion != null
      ? wf.planVersion
      : (1 as PlanVersion);
  return {
    ...base,
    fixAttemptCount: wf.fixAttemptCount + 1,
    kind: "implementing",
    planVersion,
    dispatch: defaultQueuedDispatch(wf) as DispatchSubState,
  };
}

// ---------------------------------------------------------------------------
// Resumable state helpers
// ---------------------------------------------------------------------------

function resumeFromState(
  base: WorkflowCommon,
  resumable: ResumableWorkflowState,
): DeliveryWorkflow | null {
  switch (resumable.kind) {
    case "planning":
      return { ...base, kind: "planning", planVersion: resumable.planVersion };
    case "implementing":
      return {
        ...base,
        kind: "implementing",
        planVersion: resumable.planVersion,
        dispatch: {
          kind: "queued",
          dispatchId: resumable.dispatchId,
          executionClass: "implementation_runtime",
        },
      };
    case "gating":
      return {
        ...base,
        kind: "gating",
        headSha: resumable.headSha,
        gate: emptyGateSubState(resumable.gate),
      };
    case "awaiting_pr":
      return { ...base, kind: "awaiting_pr", headSha: resumable.headSha };
    case "babysitting":
      return null; // Cannot resume directly into babysitting without review surface
  }
}

// ---------------------------------------------------------------------------
// Pure state machine reducer
// ---------------------------------------------------------------------------

export function reduceWorkflow(params: {
  snapshot: DeliveryWorkflow;
  event: LoopEvent;
  context: LoopEventContext;
  now?: Date;
}): DeliveryWorkflow | null {
  const { snapshot: wf, event, context: ctx, now = new Date() } = params;

  // Terminal states accept no transitions
  if (wf.kind === "done" || wf.kind === "stopped" || wf.kind === "terminated") {
    return null;
  }

  // Universal transitions: manual_stop, pr_closed, pr_merged apply to all active states
  if (event === "manual_stop") {
    return {
      ...bump(wf, now),
      kind: "stopped",
      reason: { kind: "user_requested" },
    };
  }
  if (event === "pr_closed") {
    return {
      ...bump(wf, now),
      kind: "terminated",
      reason: { kind: "pr_closed" },
    };
  }
  if (event === "pr_merged") {
    return {
      ...bump(wf, now),
      kind: "terminated",
      reason: { kind: "pr_merged" },
    };
  }
  if (event === "exhausted_retries") {
    const reason: ManualFixIssue = {
      description: "Retry budget exhausted",
      suggestedAction: "Review failures and manually fix the issue",
    };
    const result: WorkflowCommon & {
      kind: "awaiting_manual_fix";
      reason: ManualFixIssue;
      resumableFrom: Exclude<ResumableWorkflowState, { kind: "planning" }>;
    } = {
      ...bump(wf, now),
      kind: "awaiting_manual_fix",
      reason,
      resumableFrom: deriveResumableFrom(wf),
    };
    return result;
  }

  // State-specific transitions
  switch (wf.kind) {
    case "planning":
      return reducePlanning(wf, event, ctx, now);
    case "implementing":
      return reduceImplementing(wf, event, ctx, now);
    case "gating":
      return reduceGating(wf, event, ctx, now);
    case "awaiting_pr":
      return reduceAwaitingPr(wf, event, ctx, now);
    case "babysitting":
      return reduceBabysitting(wf, event, ctx, now);
    case "awaiting_plan_approval":
      return reduceAwaitingPlanApproval(wf, event, ctx, now);
    case "awaiting_manual_fix":
      return reduceAwaitingManualFix(wf, event, ctx, now);
    case "awaiting_operator_action":
      return reduceAwaitingOperatorAction(wf, event, ctx, now);
  }
}

function deriveResumableFrom(
  wf: DeliveryWorkflow,
): Exclude<ResumableWorkflowState, { kind: "planning" }> {
  switch (wf.kind) {
    case "implementing":
      return {
        kind: "implementing",
        dispatchId: wf.dispatch.dispatchId,
        planVersion: wf.planVersion,
      };
    case "gating":
      return {
        kind: "gating",
        gate: wf.gate.kind,
        headSha: wf.headSha,
      };
    case "awaiting_pr":
      return { kind: "awaiting_pr", headSha: wf.headSha };
    case "babysitting":
      return { kind: "babysitting", headSha: wf.headSha };
    default:
      // Fallback for states that don't map cleanly
      return {
        kind: "implementing",
        dispatchId:
          `d-fallback-${wf.version}` as import("./workflow").DispatchId,
        planVersion: ("planVersion" in wf && wf.planVersion != null
          ? wf.planVersion
          : 1) as PlanVersion,
      };
  }
}

// ---------------------------------------------------------------------------
// Per-state reducers
// ---------------------------------------------------------------------------

function reducePlanning(
  wf: Extract<DeliveryWorkflow, { kind: "planning" }>,
  event: LoopEvent,
  _ctx: LoopEventContext,
  now: Date,
): DeliveryWorkflow | null {
  if (event === "plan_completed") {
    const planVersion = (wf.planVersion ?? 1) as PlanVersion;
    return {
      ...bumpWithFixReset(wf, event, _ctx, now),
      kind: "implementing",
      planVersion,
      dispatch: defaultQueuedDispatch(wf) as DispatchSubState,
    };
  }
  return null;
}

function reduceImplementing(
  wf: Extract<DeliveryWorkflow, { kind: "implementing" }>,
  event: LoopEvent,
  ctx: LoopEventContext,
  now: Date,
): DeliveryWorkflow | null {
  if (event === "implementation_completed") {
    const headSha = (ctx.headSha ??
      `sha-impl-${wf.version}`) as import("./workflow").GitSha;
    return {
      ...bumpWithFixReset(wf, event, ctx, now),
      kind: "gating",
      headSha,
      gate: emptyGateSubState("review"),
    };
  }

  if (event === "redispatch_requested") {
    // Partial completion — stay in implementing for re-dispatch without
    // incrementing fixAttemptCount (this is normal multi-pass, not failure).
    const base = bump(wf, now);
    return {
      ...base,
      kind: "implementing",
      planVersion: wf.planVersion,
      dispatch: defaultQueuedDispatch(wf) as DispatchSubState,
    };
  }

  if (event === "gate_blocked") {
    return retryToImplementing(wf, now);
  }

  return null;
}

function reduceGating(
  wf: Extract<DeliveryWorkflow, { kind: "gating" }>,
  event: LoopEvent,
  ctx: LoopEventContext,
  now: Date,
): DeliveryWorkflow | null {
  const currentGate = wf.gate.kind;

  if (event === "gate_passed") {
    const nextGate = NEXT_GATE[currentGate];
    if (nextGate) {
      // Move to next gate
      return {
        ...bumpWithFixReset(wf, event, ctx, now),
        kind: "gating",
        headSha: wf.headSha,
        gate: emptyGateSubState(nextGate),
      };
    }
    // Last gate (ui) passed — check for PR link
    if (ctx.hasPrLink) {
      return {
        ...bumpWithFixReset(wf, event, ctx, now),
        kind: "babysitting",
        headSha: wf.headSha,
        reviewSurface: { kind: "github_pr", prNumber: ctx.prNumber ?? 0 },
        nextCheckAt: new Date(now.getTime() + 5 * 60_000),
      };
    }
    return {
      ...bumpWithFixReset(wf, event, ctx, now),
      kind: "awaiting_pr",
      headSha: wf.headSha,
    };
  }

  if (event === "gate_blocked") {
    return retryToImplementing(wf, now);
  }

  return null;
}

function reduceAwaitingPr(
  wf: Extract<DeliveryWorkflow, { kind: "awaiting_pr" }>,
  event: LoopEvent,
  ctx: LoopEventContext,
  now: Date,
): DeliveryWorkflow | null {
  if (event === "pr_linked") {
    return {
      ...bumpWithFixReset(wf, event, ctx, now),
      kind: "babysitting",
      headSha: wf.headSha,
      reviewSurface: { kind: "github_pr", prNumber: ctx.prNumber ?? 0 },
      nextCheckAt: new Date(now.getTime() + 5 * 60_000),
    };
  }
  if (event === "mark_done") {
    return {
      ...bump(wf, now),
      kind: "done",
      outcome: "completed",
      completedAt: now,
    };
  }
  return null;
}

function reduceBabysitting(
  wf: Extract<DeliveryWorkflow, { kind: "babysitting" }>,
  event: LoopEvent,
  ctx: LoopEventContext,
  now: Date,
): DeliveryWorkflow | null {
  if (event === "babysit_passed") {
    return {
      ...bump(wf, now),
      kind: "done",
      outcome: "completed",
      completedAt: now,
    };
  }
  if (event === "babysit_blocked") {
    return retryToImplementing(wf, now);
  }
  if (event === "mark_done") {
    return {
      ...bump(wf, now),
      kind: "done",
      outcome: "completed",
      completedAt: now,
    };
  }
  return null;
}

function reduceAwaitingPlanApproval(
  wf: Extract<DeliveryWorkflow, { kind: "awaiting_plan_approval" }>,
  event: LoopEvent,
  _ctx: LoopEventContext,
  now: Date,
): DeliveryWorkflow | null {
  if (event === "plan_completed") {
    const planVersion = (wf.planVersion ?? 1) as PlanVersion;
    return {
      ...bumpWithFixReset(wf, event, _ctx, now),
      kind: "implementing",
      planVersion,
      dispatch: defaultQueuedDispatch(wf) as DispatchSubState,
    };
  }
  if (event === "blocked_resume") {
    return {
      ...bump(wf, now),
      kind: "planning",
      planVersion: wf.planVersion,
    };
  }
  return null;
}

function reduceAwaitingManualFix(
  wf: Extract<DeliveryWorkflow, { kind: "awaiting_manual_fix" }>,
  event: LoopEvent,
  ctx: LoopEventContext,
  now: Date,
): DeliveryWorkflow | null {
  if (event === "blocked_resume") {
    const target = ctx.resumeTo ?? wf.resumableFrom;
    return resumeFromState(bump(wf, now), target);
  }
  return null;
}

function reduceAwaitingOperatorAction(
  wf: Extract<DeliveryWorkflow, { kind: "awaiting_operator_action" }>,
  event: LoopEvent,
  ctx: LoopEventContext,
  now: Date,
): DeliveryWorkflow | null {
  if (event === "blocked_resume") {
    const target = ctx.resumeTo ?? wf.resumableFrom;
    if (target.kind === "planning") {
      return resumeFromPlanningState(bump(wf, now), target);
    }
    return resumeFromState(bump(wf, now), target);
  }
  return null;
}

function resumeFromPlanningState(
  base: WorkflowCommon,
  resumable: Extract<ResumableWorkflowState, { kind: "planning" }>,
): DeliveryWorkflow {
  return { ...base, kind: "planning", planVersion: resumable.planVersion };
}

// ---------------------------------------------------------------------------
// Fix attempt reset logic
// ---------------------------------------------------------------------------

export function shouldResetFixAttemptCount(
  event: LoopEvent,
  _ctx: LoopEventContext,
): boolean {
  // Reset on forward progress events
  return (
    event === "plan_completed" ||
    event === "implementation_completed" ||
    event === "gate_passed" ||
    event === "pr_linked" ||
    event === "babysit_passed"
  );
}

// ---------------------------------------------------------------------------
// Derive pending action from workflow state
// ---------------------------------------------------------------------------

export function derivePendingAction(
  workflow: DeliveryWorkflow,
): PendingAction | null {
  switch (workflow.kind) {
    case "implementing": {
      if (workflow.dispatch.kind === "sent") {
        return {
          kind: "dispatch_ack",
          dispatchId: workflow.dispatch.dispatchId,
          deadlineAt: workflow.dispatch.ackDeadlineAt,
        };
      }
      return null;
    }
    case "gating":
      return { kind: "gate_result", gate: workflow.gate.kind };
    case "awaiting_plan_approval":
      return {
        kind: "human_input",
        reason: {
          kind: "plan_approval",
          planVersion: workflow.planVersion,
        },
      };
    case "awaiting_manual_fix":
      return {
        kind: "human_input",
        reason: { kind: "manual_fix", issue: workflow.reason },
      };
    case "awaiting_operator_action":
      return {
        kind: "human_input",
        reason: {
          kind: "operator_action",
          reason: workflow.reason,
          incidentId: workflow.incidentId,
        },
      };
    case "awaiting_pr":
      return { kind: "review_surface_link" };
    case "babysitting":
      return { kind: "babysit_recheck", nextCheckAt: workflow.nextCheckAt };
    default:
      return null;
  }
}

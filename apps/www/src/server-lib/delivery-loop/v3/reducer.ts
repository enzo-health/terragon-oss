import {
  AWAITING_PR_CREATION_REASON,
  classifyFailureLane,
  type EffectSpec,
  isTerminalState,
  type LoopEvent,
  type WorkflowHead,
} from "./types";

/**
 * Number of consecutive narration-only retries (zero tool calls) before
 * the reducer escalates to awaiting_manual_fix rather than scheduling
 * another dispatch. Hardcoded — no feature flag.
 */
export const NO_PROGRESS_RETRY_THRESHOLD = 3;

// Reason: A user with PR write access could trigger a wake-storm by posting
// many comments in quick succession, each resetting the agent's retry budgets
// and dispatching a new run (see PR #145 security review). Resurrection
// events within this window of the last successful resurrection no-op.
export const RESURRECTION_COOLDOWN_MS = 60_000;

const DISPATCH_COHERENT_STATES = new Set([
  "planning",
  "implementing",
  "gating_review",
  "gating_ci",
]);

type InvariantAction = {
  kind: "dispatch_coherence";
  reason: string;
  fromActiveRunId: string | null;
  toActiveRunId: string | null;
};

type BranchInvariantAction = {
  kind: "branch_coherence";
  reason: string;
  fromActiveGate: string | null;
  toActiveGate: string | null;
};

export type InvariantActionV3 = InvariantAction | BranchInvariantAction;

type ReduceResult = {
  head: WorkflowHead;
  effects: EffectSpec[];
  invariantActions: InvariantActionV3[];
};

type ApplyInvariantResult = {
  head: WorkflowHead;
  invariantActions: InvariantActionV3[];
};

function withInvariantActions(params: {
  head: WorkflowHead;
  effects: EffectSpec[];
  invariantActions: InvariantActionV3[];
}): ReduceResult {
  if (params.invariantActions.length === 0) {
    return {
      head: params.head,
      effects: params.effects,
      invariantActions: [],
    };
  }

  const invariants = params.invariantActions;
  const nextHead = invariants.reduce<WorkflowHead>((acc, action) => {
    if (action.kind === "dispatch_coherence") {
      return {
        ...acc,
        activeRunId: action.toActiveRunId,
      };
    }
    return {
      ...acc,
      activeGate: action.toActiveGate,
    };
  }, params.head);

  return {
    head: nextHead,
    effects: params.effects,
    invariantActions: invariants,
  };
}

function applyDispatchCoherence(params: {
  head: WorkflowHead;
}): ApplyInvariantResult {
  const beforeActiveRunId = params.head.activeRunId;
  if (
    DISPATCH_COHERENT_STATES.has(params.head.state) ||
    beforeActiveRunId === null
  ) {
    return {
      head: params.head,
      invariantActions: [],
    };
  }

  return {
    head: {
      ...params.head,
      activeRunId: null,
    },
    invariantActions: [
      {
        kind: "dispatch_coherence",
        reason: `Clearing stale activeRunId from non-dispatch state ${params.head.state}`,
        fromActiveRunId: beforeActiveRunId,
        toActiveRunId: null,
      },
    ],
  };
}

function expectedBranchForState(state: WorkflowHead["state"]): string | null {
  if (state === "gating_review") {
    return "review";
  }
  if (state === "gating_ci") {
    return "ci";
  }
  return null;
}

function applyBranchCoherence(params: {
  head: WorkflowHead;
}): ApplyInvariantResult {
  const beforeActiveGate = params.head.activeGate;
  const expectedActiveGate = expectedBranchForState(params.head.state);
  if (beforeActiveGate === expectedActiveGate) {
    return {
      head: params.head,
      invariantActions: [],
    };
  }

  return {
    head: {
      ...params.head,
      activeGate: expectedActiveGate,
    },
    invariantActions: [
      {
        kind: "branch_coherence",
        reason: `Normalizing activeGate for state ${params.head.state}`,
        fromActiveGate: beforeActiveGate,
        toActiveGate: expectedActiveGate,
      },
    ],
  };
}

function applyInvariantMiddleware(params: {
  head: WorkflowHead;
  effects: EffectSpec[];
}): ReduceResult {
  const dispatchResult = applyDispatchCoherence({ head: params.head });
  const branchResult = applyBranchCoherence({
    head: dispatchResult.head,
  });

  const invariantActions = [
    ...dispatchResult.invariantActions,
    ...branchResult.invariantActions,
  ];

  return withInvariantActions({
    head: branchResult.head,
    effects: params.effects,
    invariantActions,
  });
}

// Unified out-of-order signal detection with configurable strictness
type OutOfOrderCheckMode = "strict" | "lenient" | "ci-verdict";

// Specialized out-of-order check for gate signals (review/CI)
// Uses lenient mode to allow signals without runId when there's an active lease
function isOutOfOrderGateSignal(params: {
  head: WorkflowHead;
  runId: string | null | undefined;
  runSeq?: number | null;
}): boolean {
  return isOutOfOrderSignal({ ...params, mode: "lenient" });
}

// Specialized out-of-order check for failure signals with lane classification
function isOutOfOrderFailureSignal(params: {
  head: WorkflowHead;
  runId: string | null | undefined;
  runSeq?: number | null;
  category?: string | null;
  lane?: "agent" | "infra" | null;
}): boolean {
  // Always allow signals without runId (for gate-state failure retries)
  if (params.runId == null) {
    return false; // NOT out of order - process the signal
  }

  // Use lenient mode for infra lane failures (allows signals without full run context)
  if (params.lane === "infra") {
    return isOutOfOrderSignal({
      head: params.head,
      runId: params.runId,
      runSeq: params.runSeq,
      mode: "lenient",
    });
  }
  // Use strict mode for agent lane failures
  return isOutOfOrderSignal({
    head: params.head,
    runId: params.runId,
    runSeq: params.runSeq,
    mode: "strict",
  });
}

function isOutOfOrderSignal(params: {
  head: WorkflowHead;
  runId: string | null | undefined;
  runSeq?: number | null;
  headSha?: string | null;
  mode: OutOfOrderCheckMode;
}): boolean {
  // CI verdict mode: requires headSha correlation
  if (params.mode === "ci-verdict") {
    // runSeq mismatch check
    if (params.runSeq != null) {
      if (params.head.activeRunSeq == null) return true;
      if (params.runSeq !== params.head.activeRunSeq) return true;
    } else if (params.head.activeRunSeq == null) {
      return true;
    }

    // headSha is required for CI signals
    const signalHeadSha = params.headSha ?? null;
    if (!signalHeadSha) return true;
    if (params.head.headSha !== null && signalHeadSha !== params.head.headSha) {
      return true;
    }

    // If we have activeRunId but no runSeq in signal, verify runId matches
    if (params.head.activeRunId !== null && params.runSeq == null) {
      const signalRunId = params.runId ?? null;
      if (signalRunId !== null && signalRunId !== params.head.activeRunId) {
        return true;
      }
    }

    return false;
  }

  // Lenient mode: allow signals without runId (for gate verdicts)
  // This supports gate verdicts that may not include full run context
  if (params.mode === "lenient") {
    if (params.runSeq != null) {
      return (
        params.head.activeRunSeq == null ||
        params.runSeq !== params.head.activeRunSeq
      );
    }

    // Allow signals without runId - gate verdicts may not include full run context
    if (params.runId == null) {
      return false; // NOT out of order - process the signal
    }

    if (params.head.activeRunId == null) {
      return false; // NOT out of order - no active lease to mismatch against
    }

    return params.runId !== params.head.activeRunId;
  }

  // Strict mode (default): require exact runId/runSeq match
  if (params.runSeq != null) {
    return (
      params.head.activeRunSeq == null ||
      params.runSeq !== params.head.activeRunSeq
    );
  }

  if (params.head.activeRunSeq == null) {
    return true;
  }

  if (params.head.activeRunId == null) {
    return false;
  }

  if (params.runId == null) {
    return true;
  }

  return params.runId !== params.head.activeRunId;
}

function withVersion(head: WorkflowHead, now: Date): WorkflowHead {
  return {
    ...head,
    version: head.version + 1,
    updatedAt: now,
    lastActivityAt: now,
  };
}

function publishStatusEffect(head: WorkflowHead, now: Date): EffectSpec {
  return {
    kind: "publish_status",
    effectKey: `${head.workflowId}:${head.version}:publish_status`,
    dueAt: now,
    maxAttempts: 3,
    payload: { kind: "publish_status" },
  };
}

function computeRetryBackoffMs(attempt: number): number {
  const BASE_MS = 1_000;
  const MAX_MS = 30_000;
  const exponential = Math.min(MAX_MS, BASE_MS * Math.pow(2, attempt));
  return Math.floor(Math.random() * exponential);
}

function nextActiveRunSeq(head: WorkflowHead): number {
  return Math.max(head.activeRunSeq ?? 0, head.lastTerminalRunSeq ?? 0) + 1;
}

function allocateImplementationLease(params: {
  head: WorkflowHead;
  consumeCurrent: boolean;
}): Pick<
  WorkflowHead,
  "activeRunId" | "activeRunSeq" | "leaseExpiresAt" | "lastTerminalRunSeq"
> {
  return {
    activeRunId: null,
    activeRunSeq: nextActiveRunSeq(params.head),
    leaseExpiresAt: null,
    lastTerminalRunSeq: params.consumeCurrent
      ? (params.head.activeRunSeq ?? params.head.lastTerminalRunSeq)
      : params.head.lastTerminalRunSeq,
  };
}

function continueActiveLease(
  head: WorkflowHead,
): Pick<
  WorkflowHead,
  "activeRunId" | "activeRunSeq" | "leaseExpiresAt" | "lastTerminalRunSeq"
> {
  return {
    activeRunId: head.activeRunId,
    activeRunSeq: head.activeRunSeq,
    leaseExpiresAt: head.leaseExpiresAt,
    lastTerminalRunSeq: head.lastTerminalRunSeq,
  };
}

function clearActiveLease(
  head: WorkflowHead,
): Pick<
  WorkflowHead,
  "activeRunId" | "activeRunSeq" | "leaseExpiresAt" | "lastTerminalRunSeq"
> {
  return {
    activeRunId: null,
    activeRunSeq: null,
    leaseExpiresAt: null,
    lastTerminalRunSeq: head.activeRunSeq ?? head.lastTerminalRunSeq,
  };
}

function dispatchImplementingEffect(
  head: WorkflowHead,
  now: Date,
  lane: "agent" | "infra",
  infraRetryCount: number,
  retryAttempt?: number,
  retryReason?: string | null,
): EffectSpec {
  const executionClass =
    lane === "infra" && infraRetryCount > 0
      ? "implementation_runtime_fallback"
      : "implementation_runtime";
  const dueAt =
    retryAttempt != null
      ? new Date(now.getTime() + computeRetryBackoffMs(retryAttempt))
      : now;
  return {
    kind: "dispatch_implementing",
    effectKey: `${head.workflowId}:${head.version}:dispatch_implementing`,
    dueAt,
    payload: {
      kind: "dispatch_implementing",
      executionClass,
      retryReason: retryReason ?? null,
    },
  };
}

function dispatchReviewEffect(head: WorkflowHead, now: Date): EffectSpec {
  return {
    kind: "dispatch_gate_review",
    effectKey: `${head.workflowId}:${head.version}:dispatch_gate_review`,
    dueAt: now,
    payload: { kind: "dispatch_gate_review", gate: "review" },
  };
}

function ensurePrEffect(head: WorkflowHead, now: Date): EffectSpec {
  return {
    kind: "ensure_pr",
    effectKey: `${head.workflowId}:${head.version}:ensure_pr`,
    dueAt: now,
    maxAttempts: 8,
    payload: { kind: "ensure_pr" },
  };
}

function gateStalenessEffect(head: WorkflowHead, now: Date): EffectSpec {
  return {
    kind: "gate_staleness_check",
    effectKey: `${head.workflowId}:${head.version}:gate_staleness_check`,
    dueAt: new Date(now.getTime() + 5 * 60 * 1000), // 5 minutes
    payload: {
      kind: "gate_staleness_check",
      workflowVersion: head.version,
    },
  };
}

// Unified retry logic shared between planning and implementing retry paths
type RetryTargetState = "planning" | "implementing";

function executeRetry(params: {
  head: WorkflowHead;
  now: Date;
  lane: "agent" | "infra";
  reason: string | null;
  targetState: RetryTargetState;
}): ReduceResult {
  const next = withVersion(params.head, params.now);
  const laneUpdate =
    params.lane === "infra"
      ? {
          infraRetryCount: params.head.infraRetryCount + 1,
          fixAttemptCount: params.head.fixAttemptCount,
          max: params.head.maxInfraRetries,
          count: params.head.infraRetryCount + 1,
          blockedState: "awaiting_operator_action" as const,
        }
      : {
          infraRetryCount: params.head.infraRetryCount,
          fixAttemptCount: params.head.fixAttemptCount + 1,
          max: params.head.maxFixAttempts,
          count: params.head.fixAttemptCount + 1,
          blockedState: "awaiting_manual_fix" as const,
        };

  if (laneUpdate.count >= laneUpdate.max) {
    const blockedHead = {
      ...next,
      state: laneUpdate.blockedState,
      activeGate: null,
      ...clearActiveLease(params.head),
      blockedReason:
        params.reason ??
        (params.lane === "infra"
          ? "Infrastructure retry budget exhausted"
          : "Fix attempt budget exhausted"),
      fixAttemptCount: laneUpdate.fixAttemptCount,
      infraRetryCount: laneUpdate.infraRetryCount,
    };
    return {
      head: blockedHead,
      effects: [publishStatusEffect(next, params.now)],
      invariantActions: [],
    };
  }

  const retryHead = {
    ...next,
    state: params.targetState,
    activeGate: null,
    ...allocateImplementationLease({
      head: params.head,
      consumeCurrent: true,
    }),
    blockedReason: params.reason ?? null,
    fixAttemptCount: laneUpdate.fixAttemptCount,
    infraRetryCount: laneUpdate.infraRetryCount,
  };
  return {
    head: retryHead,
    effects: [
      dispatchImplementingEffect(
        next,
        params.now,
        params.lane,
        laneUpdate.infraRetryCount,
        laneUpdate.count,
        params.reason,
      ),
      publishStatusEffect(next, params.now),
    ],
    invariantActions: [],
  };
}

// Convenience wrappers for backward compatibility
function retryToImplementing(params: {
  head: WorkflowHead;
  now: Date;
  lane: "agent" | "infra";
  reason: string | null;
}): ReduceResult {
  return executeRetry({ ...params, targetState: "implementing" });
}

function retryInPlanning(params: {
  head: WorkflowHead;
  now: Date;
  lane: "agent" | "infra";
  reason: string | null;
}): ReduceResult {
  return executeRetry({ ...params, targetState: "planning" });
}

export function reduce(params: {
  head: WorkflowHead;
  event: LoopEvent;
  now?: Date;
}): ReduceResult {
  const now = params.now ?? new Date();
  const head = params.head;
  const event = params.event;

  let result: ReduceResult;
  if (event.type === "workflow_resurrected") {
    // Resurrection fires only on terminal states. On a non-terminal workflow
    // it's a no-op — the in-flight run already has its own retry budgets and
    // we don't want a racing webhook to clobber them mid-flight.
    if (!isTerminalState(head.state)) {
      result = {
        head,
        effects: [],
        invariantActions: [],
      };
    } else if (
      head.lastResurrectedAt != null &&
      now.getTime() - head.lastResurrectedAt.getTime() <
        RESURRECTION_COOLDOWN_MS
    ) {
      // Cooldown active — a resurrection fired recently. Drop this event to
      // prevent wake-storms triggered by rapid-fire PR comments / webhook
      // bursts. Same no-op shape as the non-terminal branch above.
      const secondsSince = Math.round(
        (now.getTime() - head.lastResurrectedAt.getTime()) / 1000,
      );
      console.warn(
        `[delivery-loop] workflow_resurrected cooldown skip workflowId=${head.workflowId} secondsSinceLast=${secondsSince} cooldownSeconds=${RESURRECTION_COOLDOWN_MS / 1000}`,
      );
      result = {
        head,
        effects: [],
        invariantActions: [],
      };
    } else {
      const next = withVersion(head, now);
      const resurrectedHead: WorkflowHead = {
        ...next,
        state: "implementing",
        activeGate: null,
        blockedReason: null,
        fixAttemptCount: 0,
        infraRetryCount: 0,
        narrationOnlyRetryCount: 0,
        lastResurrectedAt: now,
        ...allocateImplementationLease({
          head,
          consumeCurrent: false,
        }),
      };
      result = {
        head: resurrectedHead,
        effects: [
          dispatchImplementingEffect(
            resurrectedHead,
            now,
            "agent",
            resurrectedHead.infraRetryCount,
            undefined,
            `workflow_resurrected:${event.cause}`,
          ),
          publishStatusEffect(resurrectedHead, now),
        ],
        invariantActions: [],
      };
    }
  } else if (isTerminalState(head.state)) {
    result = {
      head,
      effects: [],
      invariantActions: [],
    };
  } else if (event.type === "stop_requested") {
    const next = withVersion(head, now);
    result = {
      head: {
        ...next,
        state: "stopped",
        blockedReason: "Stopped by user",
      },
      effects: [publishStatusEffect(next, now)],
      invariantActions: [],
    };
  } else if (event.type === "pr_closed") {
    const next = withVersion(head, now);
    result = {
      head: {
        ...next,
        state: "terminated",
        blockedReason: event.merged ? "PR merged" : "PR closed",
      },
      effects: [publishStatusEffect(next, now)],
      invariantActions: [],
    };
  } else
    switch (head.state) {
      case "planning": {
        if (event.type === "planning_run_completed") {
          const next = withVersion(head, now);
          result = {
            head: {
              ...next,
              state: "planning",
              activeGate: null,
              ...clearActiveLease(head),
              blockedReason: null,
            },
            effects: [
              {
                kind: "create_plan_artifact",
                effectKey: `${head.workflowId}:${next.version}:create_plan_artifact`,
                dueAt: now,
                payload: { kind: "create_plan_artifact" },
              },
              publishStatusEffect(next, now),
            ],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "plan_failed") {
          const next = withVersion(head, now);
          result = {
            head: {
              ...next,
              state: "awaiting_manual_fix",
              activeGate: null,
              ...clearActiveLease(head),
              blockedReason: event.reason,
            },
            effects: [publishStatusEffect(next, now)],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "bootstrap") {
          const next = withVersion(head, now);
          result = {
            head: {
              ...next,
              state: "planning",
              activeGate: null,
              ...allocateImplementationLease({
                head,
                consumeCurrent: false,
              }),
              blockedReason: null,
            },
            effects: [
              dispatchImplementingEffect(
                next,
                now,
                "agent",
                next.infraRetryCount,
              ),
              publishStatusEffect(next, now),
            ],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "dispatch_queued") {
          const next = withVersion(head, now);
          result = {
            head: {
              ...next,
              state: "planning",
              activeRunId: event.runId,
              activeRunSeq: head.activeRunSeq,
              leaseExpiresAt: event.ackDeadlineAt,
              lastTerminalRunSeq: head.lastTerminalRunSeq,
              blockedReason: null,
            },
            effects: [
              {
                kind: "run_lease_expiry_check",
                effectKey: `${head.workflowId}:${event.runId}:lease_expiry`,
                dueAt: event.ackDeadlineAt,
                payload: {
                  kind: "run_lease_expiry_check",
                  runId: event.runId,
                  workflowVersion: next.version,
                },
              },
            ],
            invariantActions: [],
          };
          break;
        }
        if (
          event.type === "dispatch_claimed" ||
          event.type === "dispatch_accepted"
        ) {
          result = {
            head,
            effects: [],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "dispatch_ack_timeout") {
          if (
            isOutOfOrderSignal({
              head,
              runId: event.runId,
              mode: "strict",
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          result = retryInPlanning({
            head,
            now,
            lane: "infra",
            reason: `Dispatch ack timeout for planning run ${event.runId}`,
          });
          break;
        }
        if (event.type === "run_failed") {
          if (
            isOutOfOrderSignal({
              head,
              runId: event.runId,
              runSeq: event.runSeq,
              mode: "strict",
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          const lane =
            event.lane ??
            classifyFailureLane({
              category: event.category,
              message: event.message,
            });
          result = retryInPlanning({
            head,
            now,
            lane,
            reason: event.message,
          });
          break;
        }
        if (event.type !== "plan_completed") {
          result = {
            head,
            effects: [],
            invariantActions: [],
          };
          break;
        }
        const next = withVersion(head, now);
        result = {
          head: {
            ...next,
            state: "implementing",
            activeGate: null,
            ...allocateImplementationLease({
              head,
              consumeCurrent: false,
            }),
            blockedReason: null,
          },
          effects: [
            dispatchImplementingEffect(
              next,
              now,
              "agent",
              next.infraRetryCount,
            ),
            publishStatusEffect(next, now),
          ],
          invariantActions: [],
        };
        break;
      }
      case "implementing": {
        if (event.type === "dispatch_queued") {
          // Queueing is authoritative for which run currently owns the active
          // implementation lease and when that lease expires if the daemon
          // never reaches a terminal handoff.
          const next = withVersion(head, now);
          result = {
            head: {
              ...next,
              state: "implementing",
              activeRunId: event.runId,
              activeRunSeq: head.activeRunSeq,
              leaseExpiresAt: event.ackDeadlineAt,
              lastTerminalRunSeq: head.lastTerminalRunSeq,
              blockedReason: null,
            },
            effects: [
              {
                kind: "run_lease_expiry_check",
                effectKey: `${head.workflowId}:${event.runId}:lease_expiry`,
                dueAt: event.ackDeadlineAt,
                payload: {
                  kind: "run_lease_expiry_check",
                  runId: event.runId,
                  workflowVersion: next.version,
                },
              },
            ],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "dispatch_claimed") {
          result = {
            head,
            effects: [],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "dispatch_accepted") {
          result = {
            head,
            effects: [],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "dispatch_ack_timeout") {
          if (
            isOutOfOrderSignal({
              head,
              runId: event.runId,
              mode: "strict",
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          // Infra timeout (not agent narration) — reset the narration counter.
          result = retryToImplementing({
            head: { ...head, narrationOnlyRetryCount: 0 },
            now,
            lane: "infra",
            reason: `Dispatch ack timeout for run ${event.runId}`,
          });
          break;
        }
        if (event.type === "run_completed") {
          if (
            isOutOfOrderSignal({
              head,
              runId: event.runId,
              runSeq: event.runSeq,
              mode: "strict",
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          const completedHeadSha = event.headSha ?? head.headSha;
          if (!completedHeadSha) {
            result = retryToImplementing({
              head: { ...head, narrationOnlyRetryCount: 0 },
              now,
              lane: "agent",
              reason: "Run completed without head SHA",
            });
            break;
          }
          // Detect no-op: agent completed but made no code changes (same SHA)
          const isNoOpRun =
            head.headSha !== null && completedHeadSha === head.headSha;
          if (isNoOpRun) {
            // No-progress guard: if the agent produced zero tool calls, this
            // is a narration-only response. Track consecutive occurrences and
            // escalate to awaiting_manual_fix after NO_PROGRESS_RETRY_THRESHOLD
            // to break the narrate-only retry loop (e.g. Codex crash pattern).
            const agentHadToolCalls = event.hasToolCalls !== false;
            if (!agentHadToolCalls) {
              const nextNarrationCount = head.narrationOnlyRetryCount + 1;
              if (nextNarrationCount >= NO_PROGRESS_RETRY_THRESHOLD) {
                // Escalate: agent is stuck in a narrate-only loop
                const next = withVersion(head, now);
                result = {
                  head: {
                    ...next,
                    state: "awaiting_manual_fix",
                    activeGate: null,
                    ...clearActiveLease(head),
                    narrationOnlyRetryCount: nextNarrationCount,
                    blockedReason:
                      "Agent is stuck in a narrate-only loop: completed without making code changes or invoking any tools in the last " +
                      nextNarrationCount +
                      " consecutive retries. Manual fix required.",
                  },
                  effects: [publishStatusEffect(next, now)],
                  invariantActions: [],
                };
                break;
              }
              result = retryToImplementing({
                head: {
                  ...head,
                  narrationOnlyRetryCount: nextNarrationCount,
                },
                now,
                lane: "agent",
                reason: "Agent completed without making code changes",
              });
            } else {
              // Agent made tool calls but still no-op — reset narration counter
              result = retryToImplementing({
                head: { ...head, narrationOnlyRetryCount: 0 },
                now,
                lane: "agent",
                reason: "Agent completed without making code changes",
              });
            }
            break;
          }
          // Successful progress: reset narration-only counter
          const next = withVersion(
            { ...head, narrationOnlyRetryCount: 0 },
            now,
          );
          result = {
            head: {
              ...next,
              state: "gating_review",
              activeGate: "review",
              headSha: completedHeadSha,
              ...continueActiveLease(head),
              blockedReason: null,
            },
            effects: [
              dispatchReviewEffect(next, now),
              publishStatusEffect(next, now),
            ],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "run_failed") {
          if (
            isOutOfOrderSignal({
              head,
              runId: event.runId,
              runSeq: event.runSeq,
              mode: "strict",
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          const lane =
            event.lane ??
            classifyFailureLane({
              category: event.category,
              message: event.message,
            });
          // A real failure (not narration-only) resets the narration counter:
          // the agent was genuinely attempting work even if it crashed.
          result = retryToImplementing({
            head: { ...head, narrationOnlyRetryCount: 0 },
            now,
            lane,
            reason: event.message,
          });
          break;
        }
        result = {
          head,
          effects: [],
          invariantActions: [],
        };
        break;
      }
      case "gating_review": {
        if (event.type === "gate_review_passed") {
          if (
            isOutOfOrderSignal({
              head,
              runId: event.runId,
              runSeq: event.runSeq,
              mode: "lenient",
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          const next = withVersion(head, now);
          const hasLinkedPr = typeof event.prNumber === "number";
          const nextHeadSha = event.headSha ?? head.headSha;
          result = {
            head: {
              ...next,
              state: hasLinkedPr ? "gating_ci" : "awaiting_pr_creation",
              activeGate: hasLinkedPr ? "ci" : null,
              headSha: nextHeadSha,
              ...continueActiveLease(head),
              blockedReason: hasLinkedPr ? null : AWAITING_PR_CREATION_REASON,
            },
            effects: hasLinkedPr
              ? [gateStalenessEffect(next, now), publishStatusEffect(next, now)]
              : [ensurePrEffect(next, now), publishStatusEffect(next, now)],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "gate_review_failed") {
          if (
            isOutOfOrderGateSignal({
              head,
              runId: event.runId,
              runSeq: event.runSeq,
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          result = retryToImplementing({
            head,
            now,
            lane: "agent",
            reason: event.reason ?? "Review gate blocked",
          });
          break;
        }
        if (event.type === "run_failed") {
          if (
            isOutOfOrderSignal({
              head,
              runId: event.runId,
              runSeq: event.runSeq,
              mode: "strict",
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          const lane =
            event.lane ??
            classifyFailureLane({
              category: event.category,
              message: event.message,
            });
          result = retryToImplementing({
            head,
            now,
            lane,
            reason: event.message,
          });
          break;
        }
        result = {
          head,
          effects: [],
          invariantActions: [],
        };
        break;
      }
      case "gating_ci": {
        if (event.type === "gate_ci_passed") {
          if (
            isOutOfOrderSignal({
              head,
              runId: event.runId,
              runSeq: event.runSeq,
              headSha: event.headSha,
              mode: "ci-verdict",
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          const next = withVersion(head, now);
          result = {
            head: {
              ...next,
              state: "awaiting_pr_lifecycle",
              activeGate: null,
              ...clearActiveLease(head),
              blockedReason: null,
            },
            effects: [publishStatusEffect(next, now)],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "gate_ci_failed") {
          if (
            isOutOfOrderSignal({
              head,
              runId: event.runId,
              runSeq: event.runSeq,
              headSha: event.headSha,
              mode: "ci-verdict",
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          result = retryToImplementing({
            head,
            now,
            lane: "agent",
            reason: event.reason ?? "CI gate blocked",
          });
          break;
        }
        if (event.type === "run_failed") {
          if (
            isOutOfOrderFailureSignal({
              head,
              runId: event.runId,
              runSeq: event.runSeq,
              category: event.category,
              lane: event.lane,
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          const lane =
            event.lane ??
            classifyFailureLane({
              category: event.category,
              message: event.message,
            });
          result = retryToImplementing({
            head,
            now,
            lane,
            reason: event.message,
          });
          break;
        }
        result = {
          head,
          effects: [],
          invariantActions: [],
        };
        break;
      }
      case "awaiting_pr_creation": {
        if (event.type === "pr_linked") {
          if (typeof event.prNumber !== "number") {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          const next = withVersion(head, now);
          result = {
            head: {
              ...next,
              state: "gating_ci",
              activeGate: "ci",
              activeRunSeq: head.activeRunSeq,
              leaseExpiresAt: head.leaseExpiresAt,
              lastTerminalRunSeq: head.lastTerminalRunSeq,
              blockedReason: null,
            },
            effects: [
              gateStalenessEffect(next, now),
              publishStatusEffect(next, now),
            ],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "gate_review_failed") {
          if (
            isOutOfOrderSignal({
              head,
              runId: event.runId,
              runSeq: event.runSeq,
              mode: "lenient",
            })
          ) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          result = retryToImplementing({
            head,
            now,
            lane: "agent",
            reason: event.reason ?? "PR linkage failed after review gate",
          });
          break;
        }
        result = {
          head,
          effects: [],
          invariantActions: [],
        };
        break;
      }
      case "awaiting_pr_lifecycle": {
        result = {
          head,
          effects: [],
          invariantActions: [],
        };
        break;
      }
      case "awaiting_manual_fix":
      case "awaiting_operator_action": {
        if (event.type !== "resume_requested") {
          result = {
            head,
            effects: [],
            invariantActions: [],
          };
          break;
        }
        const next = withVersion(head, now);
        result = {
          head: {
            ...next,
            state: "implementing",
            activeGate: null,
            ...allocateImplementationLease({
              head,
              consumeCurrent: false,
            }),
            blockedReason: null,
          },
          effects: [
            dispatchImplementingEffect(
              next,
              now,
              "agent",
              next.infraRetryCount,
            ),
            publishStatusEffect(next, now),
          ],
          invariantActions: [],
        };
        break;
      }
      default:
        result = {
          head,
          effects: [],
          invariantActions: [],
        };
        break;
    }

  return applyInvariantMiddleware({
    head: result.head,
    effects: result.effects,
  });
}

// Keep for backward compatibility - re-export the unified retry logic
export { executeRetry };

import {
  AWAITING_PR_CREATION_REASON,
  classifyFailureLane,
  type EffectSpec,
  type LoopEvent,
  type WorkflowHead,
} from "./types";

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

function isOutOfOrderRunSignal(params: {
  head: WorkflowHead;
  runId: string | null | undefined;
}): boolean {
  if (params.head.activeRunId == null) {
    return false;
  }
  if (params.runId == null) {
    return true;
  }

  return params.runId !== params.head.activeRunId;
}

function isOutOfOrderCiSignal(params: {
  head: WorkflowHead;
  event: Extract<LoopEvent, { type: "gate_ci_passed" | "gate_ci_failed" }>;
}): boolean {
  const signalHeadSha = params.event.headSha ?? null;
  if (!signalHeadSha) {
    return true;
  }

  if (params.head.headSha !== null && signalHeadSha !== params.head.headSha) {
    return true;
  }

  if (params.head.activeRunId === null) {
    return false;
  }

  const signalRunId = params.event.runId ?? null;
  if (signalRunId === null) {
    return true;
  }

  return signalRunId !== params.head.activeRunId;
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

function dispatchImplementingEffect(
  head: WorkflowHead,
  now: Date,
  lane: "agent" | "infra",
  infraRetryCount: number,
  retryAttempt?: number,
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
    payload: { kind: "dispatch_implementing", executionClass },
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

function retryToImplementing(params: {
  head: WorkflowHead;
  now: Date;
  lane: "agent" | "infra";
  reason: string | null;
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
      activeRunId: null,
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
    state: "implementing" as const,
    activeGate: null,
    activeRunId: null,
    blockedReason: null,
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
      ),
      publishStatusEffect(next, params.now),
    ],
    invariantActions: [],
  };
}

export function reduce(params: {
  head: WorkflowHead;
  event: LoopEvent;
  now?: Date;
}): ReduceResult {
  const now = params.now ?? new Date();
  const { head, event } = params;

  let result: ReduceResult;
  if (
    head.state === "done" ||
    head.state === "stopped" ||
    head.state === "terminated"
  ) {
    result = {
      head,
      effects: [],
      invariantActions: [],
    };
  } else if (event.type === "stop_requested") {
    const next = withVersion(head, now);
    result = {
      head: { ...next, state: "stopped", blockedReason: "Stopped by user" },
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
        if (event.type === "dispatch_sent") {
          const next = withVersion(head, now);
          result = {
            head: {
              ...next,
              state: "planning",
              activeRunId: event.runId,
              blockedReason: null,
            },
            effects: [
              {
                kind: "ack_timeout_check",
                effectKey: `${head.workflowId}:${event.runId}:ack_timeout`,
                dueAt: event.ackDeadlineAt,
                payload: {
                  kind: "ack_timeout_check",
                  runId: event.runId,
                  workflowVersion: next.version,
                },
              },
            ],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "planning_run_completed") {
          const next = withVersion(head, now);
          result = {
            head: {
              ...next,
              state: "planning",
              activeGate: null,
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
        if (event.type === "dispatch_sent") {
          const next = withVersion(head, now);
          result = {
            head: { ...next, activeRunId: event.runId, blockedReason: null },
            effects: [
              {
                kind: "ack_timeout_check",
                effectKey: `${head.workflowId}:${event.runId}:ack_timeout`,
                dueAt: event.ackDeadlineAt,
                payload: {
                  kind: "ack_timeout_check",
                  runId: event.runId,
                  workflowVersion: next.version,
                },
              },
            ],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "dispatch_acked") {
          if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
            result = { head, effects: [], invariantActions: [] };
            break;
          }
          const next = withVersion(head, now);
          result = {
            head: { ...next, activeRunId: event.runId },
            effects: [],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "run_completed") {
          const completedHeadSha = event.headSha ?? head.headSha;
          if (!completedHeadSha) {
            result = retryToImplementing({
              head,
              now,
              lane: "agent",
              reason: "Run completed without head SHA",
            });
            break;
          }
          const next = withVersion(head, now);
          result = {
            head: {
              ...next,
              state: "gating_review",
              activeGate: "review",
              headSha: completedHeadSha,
              activeRunId: null,
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
        if (event.type === "dispatch_ack_timeout") {
          if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
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
            lane: "infra",
            reason: `Dispatch ack timeout for run ${event.runId}`,
          });
          break;
        }
        if (event.type === "run_failed") {
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
      case "gating_review": {
        if (event.type === "dispatch_sent") {
          const next = withVersion(head, now);
          result = {
            head: { ...next, activeRunId: event.runId, blockedReason: null },
            effects: [
              {
                kind: "ack_timeout_check",
                effectKey: `${head.workflowId}:${event.runId}:ack_timeout`,
                dueAt: event.ackDeadlineAt,
                payload: {
                  kind: "ack_timeout_check",
                  runId: event.runId,
                  workflowVersion: next.version,
                },
              },
            ],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "dispatch_acked") {
          if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          const next = withVersion(head, now);
          result = {
            head: { ...next, activeRunId: event.runId },
            effects: [],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "gate_review_passed") {
          if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
          const next = withVersion(head, now);
          const hasLinkedPr = typeof event.prNumber === "number";
          result = {
            head: {
              ...next,
              state: hasLinkedPr ? "gating_ci" : "awaiting_pr",
              activeGate: hasLinkedPr ? "ci" : null,
              activeRunId: null,
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
          if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
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
          if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
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
        if (event.type === "dispatch_ack_timeout") {
          if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
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
            lane: "infra",
            reason: `Dispatch ack timeout for run ${event.runId}`,
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
          if (isOutOfOrderCiSignal({ head, event })) {
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
              state: "awaiting_pr",
              activeGate: null,
              activeRunId: null,
              blockedReason: null,
            },
            effects: [publishStatusEffect(next, now)],
            invariantActions: [],
          };
          break;
        }
        if (event.type === "gate_ci_failed") {
          if (isOutOfOrderCiSignal({ head, event })) {
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
        result = {
          head,
          effects: [],
          invariantActions: [],
        };
        break;
      }
      case "awaiting_pr": {
        if (event.type === "pr_linked") {
          if (head.blockedReason !== AWAITING_PR_CREATION_REASON) {
            result = {
              head,
              effects: [],
              invariantActions: [],
            };
            break;
          }
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
              activeRunId: null,
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
            activeRunId: null,
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

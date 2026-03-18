import {
  classifyFailureLane,
  type EffectSpecV3,
  type LoopEventV3,
  type WorkflowHeadV3,
} from "./types";

type ReduceResult = {
  head: WorkflowHeadV3;
  effects: EffectSpecV3[];
};

function isOutOfOrderRunSignal(params: {
  head: WorkflowHeadV3;
  runId: string | null | undefined;
}): boolean {
  if (params.head.activeRunId == null) {
    return false;
  }
  if (params.runId == null) {
    return false;
  }

  return params.runId == null || params.runId !== params.head.activeRunId;
}

function withVersion(head: WorkflowHeadV3, now: Date): WorkflowHeadV3 {
  return {
    ...head,
    version: head.version + 1,
    updatedAt: now,
    lastActivityAt: now,
  };
}

function dispatchImplementingEffect(
  head: WorkflowHeadV3,
  now: Date,
): EffectSpecV3 {
  return {
    kind: "dispatch_implementing",
    effectKey: `${head.workflowId}:${head.version + 1}:dispatch_implementing`,
    dueAt: now,
    payload: { kind: "dispatch_implementing" },
  };
}

function dispatchReviewEffect(head: WorkflowHeadV3, now: Date): EffectSpecV3 {
  return {
    kind: "dispatch_gate_review",
    effectKey: `${head.workflowId}:${head.version + 1}:dispatch_gate_review`,
    dueAt: now,
    payload: { kind: "dispatch_gate_review", gate: "review" },
  };
}

function retryToImplementing(params: {
  head: WorkflowHeadV3;
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
    return {
      head: {
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
      },
      effects: [],
    };
  }

  return {
    head: {
      ...next,
      state: "implementing",
      activeGate: null,
      activeRunId: null,
      blockedReason: null,
      fixAttemptCount: laneUpdate.fixAttemptCount,
      infraRetryCount: laneUpdate.infraRetryCount,
    },
    effects: [dispatchImplementingEffect(next, params.now)],
  };
}

export function reduceV3(params: {
  head: WorkflowHeadV3;
  event: LoopEventV3;
  now?: Date;
}): ReduceResult {
  const now = params.now ?? new Date();
  const { head, event } = params;

  if (
    head.state === "done" ||
    head.state === "stopped" ||
    head.state === "terminated"
  ) {
    return { head, effects: [] };
  }

  if (event.type === "stop_requested") {
    const next = withVersion(head, now);
    return {
      head: { ...next, state: "stopped", blockedReason: "Stopped by user" },
      effects: [],
    };
  }

  if (event.type === "pr_closed") {
    const next = withVersion(head, now);
    return {
      head: {
        ...next,
        state: "terminated",
        blockedReason: event.merged ? "PR merged" : "PR closed",
      },
      effects: [],
    };
  }

  switch (head.state) {
    case "planning": {
      if (event.type !== "plan_completed" && event.type !== "bootstrap") {
        return { head, effects: [] };
      }
      const next = withVersion(head, now);
      return {
        head: {
          ...next,
          state: "implementing",
          activeGate: null,
          blockedReason: null,
        },
        effects: [dispatchImplementingEffect(next, now)],
      };
    }
    case "implementing": {
      if (event.type === "dispatch_sent") {
        const next = withVersion(head, now);
        return {
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
        };
      }
      if (event.type === "dispatch_acked") {
        if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
          return { head, effects: [] };
        }
        const next = withVersion(head, now);
        return { head: { ...next, activeRunId: event.runId }, effects: [] };
      }
      if (event.type === "run_completed") {
        if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
          return { head, effects: [] };
        }
        const completedHeadSha = event.headSha ?? head.headSha;
        if (!completedHeadSha) {
          return retryToImplementing({
            head,
            now,
            lane: "agent",
            reason: "Run completed without head SHA",
          });
        }
        const next = withVersion(head, now);
        return {
          head: {
            ...next,
            state: "gating_review",
            activeGate: "review",
            headSha: completedHeadSha,
            activeRunId: null,
            blockedReason: null,
          },
          effects: [dispatchReviewEffect(next, now)],
        };
      }
      if (event.type === "dispatch_ack_timeout") {
        if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
          return { head, effects: [] };
        }
        return retryToImplementing({
          head,
          now,
          lane: "infra",
          reason: `Dispatch ack timeout for run ${event.runId}`,
        });
      }
      if (event.type === "run_failed") {
        if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
          return { head, effects: [] };
        }
        const lane =
          event.lane ??
          classifyFailureLane({
            category: event.category,
            message: event.message,
          });
        return retryToImplementing({
          head,
          now,
          lane,
          reason: event.message,
        });
      }
      return { head, effects: [] };
    }
    case "gating_review": {
      if (event.type === "dispatch_sent") {
        const next = withVersion(head, now);
        return {
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
        };
      }
      if (event.type === "dispatch_acked") {
        if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
          return { head, effects: [] };
        }
        const next = withVersion(head, now);
        return { head: { ...next, activeRunId: event.runId }, effects: [] };
      }
      if (event.type === "gate_review_passed") {
        if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
          return { head, effects: [] };
        }
        const next = withVersion(head, now);
        return {
          head: {
            ...next,
            state: "gating_ci",
            activeGate: "ci",
            activeRunId: null,
            blockedReason: null,
          },
          effects: [],
        };
      }
      if (event.type === "gate_review_failed") {
        if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
          return { head, effects: [] };
        }
        return retryToImplementing({
          head,
          now,
          lane: "agent",
          reason: event.reason ?? "Review gate blocked",
        });
      }
      if (event.type === "run_failed") {
        if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
          return { head, effects: [] };
        }
        const lane =
          event.lane ??
          classifyFailureLane({
            category: event.category,
            message: event.message,
          });
        return retryToImplementing({
          head,
          now,
          lane,
          reason: event.message,
        });
      }
      if (event.type === "dispatch_ack_timeout") {
        if (isOutOfOrderRunSignal({ head, runId: event.runId })) {
          return { head, effects: [] };
        }
        return retryToImplementing({
          head,
          now,
          lane: "infra",
          reason: `Dispatch ack timeout for run ${event.runId}`,
        });
      }
      return { head, effects: [] };
    }
    case "gating_ci": {
      if (event.type === "gate_ci_passed") {
        const next = withVersion(head, now);
        return {
          head: {
            ...next,
            state: "awaiting_pr",
            activeGate: null,
            activeRunId: null,
            blockedReason: null,
          },
          effects: [],
        };
      }
      if (event.type === "gate_ci_failed") {
        return retryToImplementing({
          head,
          now,
          lane: "agent",
          reason: event.reason ?? "CI gate blocked",
        });
      }
      return { head, effects: [] };
    }
    case "awaiting_manual_fix":
    case "awaiting_operator_action": {
      if (event.type !== "resume_requested") {
        return { head, effects: [] };
      }
      const next = withVersion(head, now);
      return {
        head: {
          ...next,
          state: "implementing",
          activeGate: null,
          activeRunId: null,
          blockedReason: null,
        },
        effects: [dispatchImplementingEffect(next, now)],
      };
    }
    default:
      return { head, effects: [] };
  }
}

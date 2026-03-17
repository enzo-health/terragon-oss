import type { DeliveryWorkflow, WorkflowId, HumanWaitReason } from "./workflow";

export type StuckReason =
  | { kind: "no_signals_received"; durationMs: number }
  | { kind: "gate_timeout"; gate: string; durationMs: number }
  | { kind: "dispatch_unacknowledged"; durationMs: number }
  | { kind: "unknown"; durationMs: number };

export type DegradedReason =
  | { kind: "repeated_failures"; failureCount: number }
  | { kind: "dlq_signals"; count: number }
  | { kind: "incident_active"; incidentType: string };

export type DeliveryWorkflowHealth =
  | { kind: "healthy" }
  | { kind: "lagging"; oldestSignalAgeSeconds: number }
  | { kind: "blocked_expected"; wait: HumanWaitReason }
  | { kind: "stuck"; stuckSince: Date; reason: StuckReason }
  | { kind: "degraded"; incidentId: string; reason: DegradedReason };

export type DeliveryIncident = {
  id: string;
  workflowId: WorkflowId;
  incidentType: string;
  severity: "warning" | "critical";
  status: "open" | "acknowledged" | "resolved";
  detail: string;
  openedAt: Date;
  resolvedAt: Date | null;
};

// Phase duration SLO thresholds (ms)
const PHASE_SLO_MS: Record<string, number> = {
  planning: 10 * 60_000,
  implementing: 30 * 60_000,
  gating: 15 * 60_000,
  awaiting_pr: 5 * 60_000,
  babysitting: 10 * 60_000,
};

const LAGGING_THRESHOLD_SECONDS = 30;
const STUCK_THRESHOLD_MS = 60 * 60_000; // 1 hour

export function deriveHealth(params: {
  workflow: DeliveryWorkflow;
  oldestUnprocessedSignalAge: number;
  openIncidents: readonly DeliveryIncident[];
  now: Date;
}): DeliveryWorkflowHealth {
  const { workflow, oldestUnprocessedSignalAge, openIncidents, now } = params;

  // Check for active incidents first
  const criticalIncident = openIncidents.find(
    (i) => i.severity === "critical" && i.status === "open",
  );
  if (criticalIncident) {
    return {
      kind: "degraded",
      incidentId: criticalIncident.id,
      reason: {
        kind: "incident_active",
        incidentType: criticalIncident.incidentType,
      },
    };
  }

  // Check for human-wait states (expected blocking)
  if (workflow.kind === "awaiting_plan_approval") {
    return {
      kind: "blocked_expected",
      wait: { kind: "plan_approval", planVersion: workflow.planVersion },
    };
  }
  if (workflow.kind === "awaiting_manual_fix") {
    return {
      kind: "blocked_expected",
      wait: { kind: "manual_fix", issue: workflow.reason },
    };
  }
  if (workflow.kind === "awaiting_operator_action") {
    return {
      kind: "blocked_expected",
      wait: {
        kind: "operator_action",
        reason: workflow.reason,
        incidentId: workflow.incidentId,
      },
    };
  }

  // Check for stuck state
  const phaseDurationMs = now.getTime() - workflow.updatedAt.getTime();
  const sloMs = PHASE_SLO_MS[workflow.kind] ?? STUCK_THRESHOLD_MS;
  if (phaseDurationMs > sloMs) {
    return {
      kind: "stuck",
      stuckSince: workflow.updatedAt,
      reason: { kind: "no_signals_received", durationMs: phaseDurationMs },
    };
  }

  // Check for signal lag
  if (oldestUnprocessedSignalAge > LAGGING_THRESHOLD_SECONDS) {
    return {
      kind: "lagging",
      oldestSignalAgeSeconds: oldestUnprocessedSignalAge,
    };
  }

  return { kind: "healthy" };
}

// Alerting predicates
export function shouldOpenIncident(params: {
  workflow: DeliveryWorkflow;
  phaseDurationMs: number;
  fixAttemptCount: number;
  maxFixAttempts: number;
  unprocessedSignalCount: number;
  dlqSignalCount: number;
}): {
  incidentType: string;
  severity: "warning" | "critical";
  detail: string;
} | null {
  const {
    workflow,
    phaseDurationMs,
    fixAttemptCount,
    maxFixAttempts,
    unprocessedSignalCount,
    dlqSignalCount,
  } = params;

  const sloMs = PHASE_SLO_MS[workflow.kind] ?? STUCK_THRESHOLD_MS;
  if (phaseDurationMs > sloMs * 2) {
    return {
      incidentType: "stuck_in_phase",
      severity: "critical",
      detail: `Stuck in ${workflow.kind} for ${Math.round(phaseDurationMs / 60_000)}m`,
    };
  }
  if (phaseDurationMs > sloMs) {
    return {
      incidentType: "stuck_in_phase",
      severity: "warning",
      detail: `Approaching SLO for ${workflow.kind}`,
    };
  }
  if (fixAttemptCount >= maxFixAttempts - 1) {
    return {
      incidentType: "budget_exhaustion_imminent",
      severity: "warning",
      detail: `Fix attempts ${fixAttemptCount}/${maxFixAttempts}`,
    };
  }
  if (unprocessedSignalCount > 20) {
    return {
      incidentType: "signal_backlog",
      severity: "warning",
      detail: `${unprocessedSignalCount} unprocessed signals`,
    };
  }
  if (dlqSignalCount > 0) {
    return {
      incidentType: "dlq_spike",
      severity: "critical",
      detail: `${dlqSignalCount} dead-lettered signals`,
    };
  }
  return null;
}

// Replay entry for debug
export type ReplayEntry = {
  timestamp: Date;
  source: "workflow_event" | "signal" | "work_item" | "incident";
  summary: string;
  detail: Record<string, unknown>;
};

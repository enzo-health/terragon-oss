export type PhaseMetric = {
  phase: string;
  durationMs: number;
  enteredAt: string; // ISO
  exitedAt: string; // ISO
  entryCount: number;
};

export type GateMetric = {
  gateType: string; // "review" | "ci" | "ui"
  durationMs: number;
  attempts: number;
  finalVerdict: string; // "approved" | "failed" | "bypassed"
};

export type FailurePattern = {
  category: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  messages: string[]; // unique failure messages (capped at 5)
};

export type RetryMetric = {
  totalRetries: number;
  infraRetries: number;
  agentRetries: number;
  maxConsecutiveFailures: number;
};

export type WorkflowRetrospective = {
  id: string;
  workflowId: string;
  outcome: "done" | "stopped" | "terminated";
  e2eDurationMs: number;
  phaseMetrics: PhaseMetric[];
  gateMetrics: GateMetric[];
  failurePatterns: FailurePattern[];
  retryMetrics: RetryMetric;
  dispatchCount: number;
  createdAt: Date;
};

/** Raw event row shape from the DB (subset we need). */
type EventRow = {
  eventKind: string;
  stateBefore: string;
  stateAfter: string | null;
  gateBefore: string | null;
  gateAfter: string | null;
  payloadJson: unknown;
  occurredAt: Date;
  previousPhaseDurationMs: number | null;
};

/**
 * Pure function: compute retrospective metrics from an ordered event stream.
 *
 * Events are expected to be ordered by `seq` ascending.
 */
export function computeRetrospective(params: {
  workflowId: string;
  events: EventRow[];
  outcome: "done" | "stopped" | "terminated";
  now: Date;
}): Omit<WorkflowRetrospective, "id" | "createdAt"> {
  const { workflowId, events, outcome, now } = params;

  // --- Phase metrics ---
  const phaseMap = new Map<
    string,
    { enteredAt: Date; exitedAt: Date; totalMs: number; entryCount: number }
  >();

  for (const ev of events) {
    // Track phase entries via stateBefore → stateAfter transitions
    if (ev.stateAfter && ev.stateBefore !== ev.stateAfter) {
      // Record exit time for the previous phase
      const prev = phaseMap.get(ev.stateBefore);
      if (prev) {
        prev.exitedAt = ev.occurredAt;
        if (ev.previousPhaseDurationMs != null) {
          prev.totalMs += ev.previousPhaseDurationMs;
        }
      }

      // Record entry for the new phase
      const existing = phaseMap.get(ev.stateAfter);
      if (existing) {
        existing.entryCount++;
      } else {
        phaseMap.set(ev.stateAfter, {
          enteredAt: ev.occurredAt,
          exitedAt: now,
          totalMs: 0,
          entryCount: 1,
        });
      }
    }
  }

  // If events exist, seed the initial state
  if (events.length > 0) {
    const firstState = events[0]!.stateBefore;
    if (!phaseMap.has(firstState)) {
      phaseMap.set(firstState, {
        enteredAt: events[0]!.occurredAt,
        exitedAt: events.length > 1 ? events[1]!.occurredAt : now,
        totalMs: 0,
        entryCount: 1,
      });
    }
  }

  const phaseMetrics: PhaseMetric[] = Array.from(phaseMap.entries()).map(
    ([phase, m]) => ({
      phase,
      durationMs:
        m.totalMs > 0
          ? m.totalMs
          : m.exitedAt.getTime() - m.enteredAt.getTime(),
      enteredAt: m.enteredAt.toISOString(),
      exitedAt: m.exitedAt.toISOString(),
      entryCount: m.entryCount,
    }),
  );

  // --- Gate metrics ---
  const gateMap = new Map<
    string,
    { enteredAt: Date; exitedAt: Date; attempts: number; finalVerdict: string }
  >();

  for (const ev of events) {
    if (ev.eventKind === "gate_entered") {
      const payload = ev.payloadJson as Record<string, unknown> | null;
      const gate = (payload?.gate as string) ?? ev.gateAfter ?? "unknown";
      const existing = gateMap.get(gate);
      if (existing) {
        existing.attempts++;
      } else {
        gateMap.set(gate, {
          enteredAt: ev.occurredAt,
          exitedAt: now,
          attempts: 1,
          finalVerdict: "failed",
        });
      }
    }

    if (ev.eventKind === "gate_evaluated") {
      const payload = ev.payloadJson as Record<string, unknown> | null;
      const gate = (payload?.gate as string) ?? ev.gateBefore ?? "unknown";
      const passed = (payload?.passed as boolean) ?? false;
      const entry = gateMap.get(gate);
      if (entry) {
        entry.exitedAt = ev.occurredAt;
        entry.finalVerdict = passed ? "approved" : "failed";
      }
    }

    // Detect bypass via human_bypass signals
    if (
      ev.eventKind === "gate_passed" &&
      ev.stateBefore === "gating" &&
      ev.stateAfter === "gating"
    ) {
      const gate = ev.gateBefore ?? "unknown";
      const entry = gateMap.get(gate);
      if (entry) {
        entry.exitedAt = ev.occurredAt;
        entry.finalVerdict = "bypassed";
      }
    }
  }

  const gateMetrics: GateMetric[] = Array.from(gateMap.entries()).map(
    ([gateType, m]) => ({
      gateType,
      durationMs: m.exitedAt.getTime() - m.enteredAt.getTime(),
      attempts: m.attempts,
      finalVerdict: m.finalVerdict,
    }),
  );

  // --- Failure patterns ---
  const failureMap = new Map<
    string,
    {
      count: number;
      firstSeenAt: Date;
      lastSeenAt: Date;
      messages: Set<string>;
    }
  >();

  for (const ev of events) {
    if (
      ev.eventKind === "implementation_failed" ||
      ev.eventKind === "dispatch_failed"
    ) {
      const payload = ev.payloadJson as Record<string, unknown> | null;
      const failure = payload?.failure as Record<string, unknown> | undefined;
      const category = (failure?.kind as string) ?? ev.eventKind;
      const message =
        (failure?.message as string) ??
        (payload?.errorMessage as string) ??
        ev.eventKind;

      const existing = failureMap.get(category);
      if (existing) {
        existing.count++;
        existing.lastSeenAt = ev.occurredAt;
        if (existing.messages.size < 5) {
          existing.messages.add(message);
        }
      } else {
        failureMap.set(category, {
          count: 1,
          firstSeenAt: ev.occurredAt,
          lastSeenAt: ev.occurredAt,
          messages: new Set([message]),
        });
      }
    }
  }

  const failurePatterns: FailurePattern[] = Array.from(
    failureMap.entries(),
  ).map(([category, m]) => ({
    category,
    count: m.count,
    firstSeenAt: m.firstSeenAt.toISOString(),
    lastSeenAt: m.lastSeenAt.toISOString(),
    messages: Array.from(m.messages),
  }));

  // --- Retry metrics ---
  let totalRetries = 0;
  let infraRetries = 0;
  let agentRetries = 0;
  let consecutiveFailures = 0;
  let maxConsecutiveFailures = 0;

  for (const ev of events) {
    if (
      ev.eventKind === "implementation_failed" ||
      ev.eventKind === "dispatch_failed"
    ) {
      totalRetries++;
      consecutiveFailures++;
      maxConsecutiveFailures = Math.max(
        maxConsecutiveFailures,
        consecutiveFailures,
      );

      const payload = ev.payloadJson as Record<string, unknown> | null;
      if (payload?.infraRetry === true) {
        infraRetries++;
      } else {
        agentRetries++;
      }
    } else if (
      ev.eventKind === "implementation_succeeded" ||
      ev.eventKind === "dispatch_acknowledged"
    ) {
      consecutiveFailures = 0;
    }
  }

  const retryMetrics: RetryMetric = {
    totalRetries,
    infraRetries,
    agentRetries,
    maxConsecutiveFailures,
  };

  // --- Dispatch count ---
  const dispatchCount = events.filter(
    (ev) => ev.eventKind === "dispatch_enqueued",
  ).length;

  // --- E2E duration ---
  const firstEvent = events[0];
  const e2eDurationMs = firstEvent
    ? now.getTime() - firstEvent.occurredAt.getTime()
    : 0;

  return {
    workflowId,
    outcome,
    e2eDurationMs,
    phaseMetrics,
    gateMetrics,
    failurePatterns,
    retryMetrics,
    dispatchCount,
  };
}

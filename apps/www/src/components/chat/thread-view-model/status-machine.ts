import type { ThreadStatus } from "@terragon/shared";

/**
 * Whether an authoritatively reported status (a `thread.status_changed` event)
 * means a run has begun. Narrow on purpose: only the two in-flight statuses
 * count. Kept distinct from `runStartedForOptimisticStatus` — these two rules
 * genuinely differ today, and unifying them would flip ~15 cold-path statuses.
 */
export function runStartedForReportedStatus(status: ThreadStatus): boolean {
  return status === "working" || status === "booting";
}

/**
 * Whether an optimistically set status means a run has begun. Used by the
 * optimistic-submit flip (status-setter), which thread-promptbox's pre-sandbox
 * placeholder gate reads. Broader than the reported-status rule (any non-null,
 * non-complete status counts) because the optimistic flip writes `booting`
 * before any authoritative status arrives.
 */
export function runStartedForOptimisticStatus(
  status: ThreadStatus | null,
): boolean {
  return status !== null && status !== "complete";
}

/**
 * Snapshot seeding keys `runStarted` off the presence of a `runId`, not a
 * status: a seeded snapshot carrying a runId is treated as in-flight regardless
 * of the status string.
 */
export function runStartedForRunId(runId: string | null | undefined): boolean {
  return runId !== null && runId !== undefined;
}

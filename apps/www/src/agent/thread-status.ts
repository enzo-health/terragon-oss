import {
  ThreadStatusDeprecated,
  ThreadStatus,
  ThreadQueuedStatus,
} from "@terragon/shared";

/** Type guard: true when the thread is waiting in a queue before sandbox boot. */
export function isQueuedStatus(
  status: ThreadStatus,
): status is ThreadQueuedStatus | "queued-blocked" {
  switch (status) {
    case "queued":
    case "queued-blocked":
    case "queued-tasks-concurrency":
    case "queued-sandbox-creation-rate-limit":
    case "queued-agent-rate-limit":
      return true;
    default:
      return false;
  }
}

/**
 * True only for statuses that occur before the sandbox is running. Used to
 * decide whether the UI should tell the user "sandbox is provisioning".
 * Once the thread moves past booting, the sandbox exists server-side even if
 * the client prop hasn't caught up yet.
 */
export function isPreSandboxStatus(status: ThreadStatus) {
  switch (status) {
    case "queued":
    case "queued-blocked":
    case "queued-sandbox-creation-rate-limit":
    case "queued-tasks-concurrency":
    case "queued-agent-rate-limit":
    case "booting":
      return true;
    case "draft":
    case "scheduled":
    case "working":
    case "stopping":
    case "checkpointing":
    case "working-stopped":
    case "working-error":
    case "working-done":
    case "stopped":
    case "complete":
    case "error":
      return false;
    default:
      const _exhaustiveCheck: never = status;
      return _exhaustiveCheck && false;
  }
}

export function isAgentWorking(status: ThreadStatus) {
  switch (status) {
    case "queued":
    case "queued-blocked":
    case "queued-sandbox-creation-rate-limit":
    case "queued-tasks-concurrency":
    case "queued-agent-rate-limit":
    case "booting":
    case "working":
    case "stopping":
    case "working-stopped":
    case "working-error":
    case "working-done":
    case "checkpointing":
      return true;
    case "draft":
    case "scheduled":
    case "stopped":
    case "complete":
    case "error":
      return false;
    default:
      const _exhaustiveCheck: never = status;
      return _exhaustiveCheck && false;
  }
}

export function isAgentStoppable(status: ThreadStatus) {
  switch (status) {
    case "queued":
    case "queued-blocked":
    case "queued-sandbox-creation-rate-limit":
    case "queued-tasks-concurrency":
    case "queued-agent-rate-limit":
    case "booting":
    case "working":
    case "scheduled":
    case "checkpointing":
    case "stopping":
    case "working-stopped":
    case "working-error":
    case "working-done":
      return true;
    case "draft":
    case "stopped":
    case "error":
    case "complete":
      return false;
    default:
      const _exhaustiveCheck: never = status;
      return _exhaustiveCheck && false;
  }
}

export const allDeprecatedThreadStatuses: Record<
  ThreadStatusDeprecated,
  boolean
> = {
  "queued-blocked": true,
  "working-stopped": true,
  error: true,
  stopped: true,
};

export const allThreadStatuses: Record<ThreadStatus, boolean> = {
  draft: true,
  scheduled: true,
  queued: true,
  "queued-sandbox-creation-rate-limit": true,
  "queued-tasks-concurrency": true,
  "queued-agent-rate-limit": true,
  booting: true,
  working: true,
  stopping: true,
  checkpointing: true,
  "working-error": true,
  "working-done": true,
  complete: true,
  ...allDeprecatedThreadStatuses,
};

export function combineThreadStatuses(statuses: ThreadStatus[]): ThreadStatus {
  if (statuses.length === 1) {
    return statuses[0]!;
  }
  const workingStatus = statuses.find((status) => isAgentWorking(status));
  if (workingStatus) {
    return workingStatus;
  }
  const stoppableStatus = statuses.find((status) => isAgentStoppable(status));
  if (stoppableStatus) {
    return stoppableStatus;
  }
  return "complete";
}

import type { ThreadStatus } from "../db/types";

type ThreadLifecyclePolicy = {
  concurrencyActive: boolean;
  primaryChatLive: boolean;
  processQueuedFollowUpImmediately: boolean;
  followUpQueueBlockReason: FollowUpQueueBlockReason | null;
};

export type FollowUpQueueBlockReason =
  | "agent_rate_limited"
  | "scheduled_not_runnable";

const THREAD_LIFECYCLE_POLICY = {
  draft: {
    concurrencyActive: false,
    primaryChatLive: false,
    processQueuedFollowUpImmediately: true,
    followUpQueueBlockReason: null,
  },
  scheduled: {
    concurrencyActive: false,
    primaryChatLive: false,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: "scheduled_not_runnable",
  },
  queued: {
    concurrencyActive: false,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "queued-blocked": {
    concurrencyActive: false,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "queued-sandbox-creation-rate-limit": {
    concurrencyActive: false,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "queued-tasks-concurrency": {
    concurrencyActive: false,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "queued-agent-rate-limit": {
    concurrencyActive: false,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: "agent_rate_limited",
  },
  booting: {
    concurrencyActive: true,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  working: {
    concurrencyActive: true,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  stopping: {
    concurrencyActive: false,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "working-stopped": {
    concurrencyActive: false,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "working-error": {
    concurrencyActive: false,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: true,
    followUpQueueBlockReason: null,
  },
  "working-done": {
    concurrencyActive: false,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: true,
    followUpQueueBlockReason: null,
  },
  checkpointing: {
    concurrencyActive: false,
    primaryChatLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  stopped: {
    concurrencyActive: false,
    primaryChatLive: false,
    processQueuedFollowUpImmediately: true,
    followUpQueueBlockReason: null,
  },
  error: {
    concurrencyActive: false,
    primaryChatLive: false,
    processQueuedFollowUpImmediately: true,
    followUpQueueBlockReason: null,
  },
  complete: {
    concurrencyActive: false,
    primaryChatLive: false,
    processQueuedFollowUpImmediately: true,
    followUpQueueBlockReason: null,
  },
} satisfies Record<ThreadStatus, ThreadLifecyclePolicy>;

export const CONCURRENCY_ACTIVE_THREAD_STATUSES = [
  "booting",
  "working",
] as const satisfies readonly ThreadStatus[];

export const PRIMARY_CHAT_LIVE_THREAD_STATUSES = [
  "queued",
  "queued-blocked",
  "queued-sandbox-creation-rate-limit",
  "queued-tasks-concurrency",
  "queued-agent-rate-limit",
  "booting",
  "working",
  "stopping",
  "working-stopped",
  "working-error",
  "working-done",
  "checkpointing",
] as const satisfies readonly ThreadStatus[];

export function isConcurrencyActiveThreadStatus(status: ThreadStatus): boolean {
  return THREAD_LIFECYCLE_POLICY[status].concurrencyActive;
}

export function isPrimaryChatLiveThreadStatus(status: ThreadStatus): boolean {
  return THREAD_LIFECYCLE_POLICY[status].primaryChatLive;
}

// Post-turn finishing states: the agent's turn has ended (output complete) but the
// thread is still occupied wrapping up (checkpoint/PR, error/stop cleanup). They are
// primaryChatLive (the sandbox is busy, follow-ups still queue) but the composer
// should present as idle — no stop button, normal placeholder — since the agent is
// no longer producing output.
const AGENT_TURN_FINISHED_STATUSES = new Set<ThreadStatus>([
  "working-done",
  "working-error",
  "working-stopped",
  "checkpointing",
]);

/**
 * True while the agent's turn is actively producing output. Drives composer
 * *display* (stop button, placeholder) — NOT routing or concurrency, which stay on
 * `primaryChatLive` so follow-ups still queue safely during checkpoint.
 */
export function isAgentRunLiveThreadStatus(status: ThreadStatus): boolean {
  return (
    THREAD_LIFECYCLE_POLICY[status].primaryChatLive &&
    !AGENT_TURN_FINISHED_STATUSES.has(status)
  );
}

export function shouldProcessQueuedFollowUpImmediately(
  status: ThreadStatus,
): boolean {
  return THREAD_LIFECYCLE_POLICY[status].processQueuedFollowUpImmediately;
}

export function getFollowUpQueueBlockReason(
  status: ThreadStatus,
): FollowUpQueueBlockReason | null {
  return THREAD_LIFECYCLE_POLICY[status].followUpQueueBlockReason;
}

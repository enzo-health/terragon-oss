import type { ThreadStatus } from "../db/types";

type ThreadLifecyclePolicy = {
  concurrencyActive: boolean;
  primaryChatLive: boolean;
  /**
   * True while the agent's turn is actively producing output. Subset of
   * `primaryChatLive` that excludes the post-turn finishing states (the agent is
   * done but the thread is still wrapping up: checkpoint/PR, error/stop cleanup).
   * Drives composer *display* (stop button, placeholder); routing/concurrency stay
   * on `primaryChatLive` so follow-ups still queue during checkpoint.
   */
  agentRunLive: boolean;
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
    agentRunLive: false,
    processQueuedFollowUpImmediately: true,
    followUpQueueBlockReason: null,
  },
  scheduled: {
    concurrencyActive: false,
    primaryChatLive: false,
    agentRunLive: false,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: "scheduled_not_runnable",
  },
  queued: {
    concurrencyActive: false,
    primaryChatLive: true,
    agentRunLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "queued-blocked": {
    concurrencyActive: false,
    primaryChatLive: true,
    agentRunLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "queued-sandbox-creation-rate-limit": {
    concurrencyActive: false,
    primaryChatLive: true,
    agentRunLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "queued-tasks-concurrency": {
    concurrencyActive: false,
    primaryChatLive: true,
    agentRunLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "queued-agent-rate-limit": {
    concurrencyActive: false,
    primaryChatLive: true,
    agentRunLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: "agent_rate_limited",
  },
  booting: {
    concurrencyActive: true,
    primaryChatLive: true,
    agentRunLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  working: {
    concurrencyActive: true,
    primaryChatLive: true,
    agentRunLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  stopping: {
    concurrencyActive: false,
    primaryChatLive: true,
    agentRunLive: true,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "working-stopped": {
    concurrencyActive: false,
    primaryChatLive: true,
    agentRunLive: false,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  "working-error": {
    concurrencyActive: false,
    primaryChatLive: true,
    agentRunLive: false,
    processQueuedFollowUpImmediately: true,
    followUpQueueBlockReason: null,
  },
  "working-done": {
    concurrencyActive: false,
    primaryChatLive: true,
    agentRunLive: false,
    processQueuedFollowUpImmediately: true,
    followUpQueueBlockReason: null,
  },
  checkpointing: {
    concurrencyActive: false,
    primaryChatLive: true,
    agentRunLive: false,
    processQueuedFollowUpImmediately: false,
    followUpQueueBlockReason: null,
  },
  stopped: {
    concurrencyActive: false,
    primaryChatLive: false,
    agentRunLive: false,
    processQueuedFollowUpImmediately: true,
    followUpQueueBlockReason: null,
  },
  error: {
    concurrencyActive: false,
    primaryChatLive: false,
    agentRunLive: false,
    processQueuedFollowUpImmediately: true,
    followUpQueueBlockReason: null,
  },
  complete: {
    concurrencyActive: false,
    primaryChatLive: false,
    agentRunLive: false,
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

export function isAgentRunLiveThreadStatus(status: ThreadStatus): boolean {
  return THREAD_LIFECYCLE_POLICY[status].agentRunLive;
}

/**
 * True for the terminal resting states (`complete`/`error`/`stopped`) — the run is
 * over and the thread is idle. Derived from the table: not chat-live, and not one of
 * the pre-run states (`draft`/`scheduled`) which are also not chat-live. Single
 * source of truth so a new status can't drift a hand-maintained list.
 */
export function isTerminalThreadStatus(status: ThreadStatus): boolean {
  return (
    !THREAD_LIFECYCLE_POLICY[status].primaryChatLive &&
    status !== "draft" &&
    status !== "scheduled"
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

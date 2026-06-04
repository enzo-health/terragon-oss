import type { ThreadStatus } from "@terragon/shared";
import { runStartedForOptimisticStatus } from "./status-machine";
import type { ThreadViewLifecycle, ThreadViewModelState } from "./types";

/**
 * Thread status lives only on `lifecycle.threadStatus`; the public
 * ThreadViewModel exposes a top-level `threadStatus` derived from it in
 * `projectThreadViewModel`. These helpers are the one place an optimistic flip /
 * rollback writes the status, keeping the derived `runStarted` in sync.
 *
 * `applyAgUiEvent` does not use these: it computes a fresh `lifecycle` directly.
 */
export function setThreadStatus(
  state: ThreadViewModelState,
  nextStatus: ThreadStatus | null,
): ThreadViewModelState {
  return {
    ...state,
    lifecycle: {
      ...state.lifecycle,
      threadStatus: nextStatus,
      runStarted: runStartedForOptimisticStatus(nextStatus),
    },
  };
}

/**
 * Re-adopt a previously captured lifecycle (used on optimistic rollback) so
 * `threadStatus` / `runStarted` / `runId` / `threadChatUpdatedAt` return to
 * their pre-flip values.
 */
export function restoreThreadStatus(
  state: ThreadViewModelState,
  priorLifecycle: ThreadViewLifecycle,
): ThreadViewModelState {
  return {
    ...state,
    lifecycle: priorLifecycle,
  };
}

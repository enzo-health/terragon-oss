import type { ThreadStatus } from "@terragon/shared";
import type { ThreadViewLifecycle, ThreadViewModelState } from "./types";

/**
 * The two thread-status fields — `state.threadStatus` and
 * `state.lifecycle.threadStatus` — must always agree. These helpers are the one
 * place an optimistic flip / rollback writes both together so they cannot drift.
 *
 * They write ONLY `threadStatus` + `lifecycle` (and the derived
 * `lifecycle.runStarted`). They never touch `dbMessages`, `sidePanel`, or
 * `optimisticSubmission`, so callers spread those from the original state after
 * spreading the setter result.
 *
 * `applyAgUiEvent` does not use these: it derives `threadStatus` from a freshly
 * computed `lifecycle` on a single line, which cannot diverge.
 */
export function setThreadStatus(
  state: ThreadViewModelState,
  nextStatus: ThreadStatus | null,
): ThreadViewModelState {
  return {
    ...state,
    threadStatus: nextStatus,
    lifecycle: {
      ...state.lifecycle,
      threadStatus: nextStatus,
      runStarted: nextStatus !== null && nextStatus !== "complete",
    },
  };
}

/**
 * Re-adopt a previously captured status + lifecycle (used on optimistic
 * rollback). Restores `threadStatus` and the full `lifecycle` object so
 * `runStarted` / `runId` / `threadChatUpdatedAt` return to their pre-flip
 * values, keeping the two status fields in agreement.
 */
export function restoreThreadStatus(
  state: ThreadViewModelState,
  priorThreadStatus: ThreadStatus | null,
  priorLifecycle: ThreadViewLifecycle,
): ThreadViewModelState {
  return {
    ...state,
    threadStatus: priorThreadStatus,
    lifecycle: priorLifecycle,
  };
}

import type { DB } from "@terragon/shared/db";
import {
  type CompleteAgentRunContextTerminalResult,
  completeAgentRunContextTerminal,
} from "@terragon/shared/model/agent-run-context";
import {
  type UpdateThreadChatWithTransitionParams,
  type UpdateThreadChatWithTransitionResult,
  updateThreadChatWithTransition,
} from "@/agent/update-status";
import { buildTerminalLifecyclePolicy } from "@/server-lib/daemon-event/run-completion";

const TERMINAL_RUN_STATUSES = ["completed", "failed", "stopped"] as const;
type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

function asTerminalRunStatus(status: string): TerminalRunStatus | null {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
    ? (status as TerminalRunStatus)
    : null;
}

type FenceInput = Omit<
  Parameters<typeof completeAgentRunContextTerminal>[0],
  "db"
>;

type TransitionInput = Omit<UpdateThreadChatWithTransitionParams, "db">;

export type CommitTerminalRunResult = {
  fence: CompleteAgentRunContextTerminalResult | null;
  transition: UpdateThreadChatWithTransitionResult | null;
  /**
   * True when the fence was rejected because a *different* terminal already won
   * the run-context, and we transitioned the chat to reflect that winner rather
   * than the caller's attempted status. This closes the stop-vs-natural-completion
   * split: a stopped run-context reconciles a `stopping` chat to `complete`.
   */
  reconciled: boolean;
};

/**
 * The single choke point that couples `thread_chat.status` to the run-context
 * terminal fence. Both writes run in ONE transaction so no early return or error
 * can leave a terminal run-context with a live chat (or vice-versa).
 *
 * - `fence` absent → transition only (e.g. a swept chat with no run-context).
 * - fence committed / duplicate → apply the caller's terminal chat transition.
 * - fence rejected as `already_terminal_different_event` → derive the chat
 *   transition from the winning run-context status (reconcile).
 * - fence rejected for any other reason (stale/superseded/mismatch) → no
 *   transition; the caller owns the rejection response.
 *
 * Broadcasts (`thread.status_changed` + thread patch) still fire from inside
 * `updateThreadChatWithTransition` on a successful transition.
 */
export async function commitTerminalRunAndChatStatus({
  db,
  fence,
  transition,
  disableGitCheckpointing = false,
}: {
  db: DB;
  fence: FenceInput | null;
  transition: TransitionInput;
  disableGitCheckpointing?: boolean;
}): Promise<CommitTerminalRunResult> {
  return db.transaction(async (tx) => {
    // A drizzle transaction is a valid query runner for these model functions but
    // its type omits the `$client` field on `DB`; the cast keeps both writes on the
    // same transaction handle so they commit or roll back together.
    const txDb = tx as unknown as DB;
    if (!fence) {
      const t = await updateThreadChatWithTransition({
        db: txDb,
        ...transition,
      });
      return { fence: null, transition: t, reconciled: false };
    }

    const fenceResult = await completeAgentRunContextTerminal({
      db: txDb,
      ...fence,
    });

    if (
      fenceResult.status === "committed" ||
      fenceResult.status === "duplicate"
    ) {
      const t = await updateThreadChatWithTransition({
        db: txDb,
        ...transition,
      });
      return { fence: fenceResult, transition: t, reconciled: false };
    }

    // Rejected. Only reconcile when a *different* terminal already won this same
    // run-context — the chat must reflect the actual winner (e.g. a user stop
    // that fenced `stopped` before the daemon's natural terminal arrived). Every
    // other rejection (stale_run, context_mismatch, not_found, stale_sequence)
    // means this event does not own the chat, so we must not transition it.
    const winnerStatus =
      fenceResult.reason === "already_terminal_different_event" &&
      fenceResult.runContext
        ? asTerminalRunStatus(fenceResult.runContext.status)
        : null;
    if (winnerStatus) {
      const { eventType } = buildTerminalLifecyclePolicy({
        status: winnerStatus,
        disableGitCheckpointing,
      });
      const t = await updateThreadChatWithTransition({
        db: txDb,
        ...transition,
        eventType,
      });
      return { fence: fenceResult, transition: t, reconciled: true };
    }

    return { fence: fenceResult, transition: null, reconciled: false };
  });
}

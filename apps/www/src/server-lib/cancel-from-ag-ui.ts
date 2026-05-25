import { getThreadChat } from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { stopThread as stopThreadInternal } from "@/server-lib/stop-thread";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type CancelResult =
  | { ok: true }
  | { skipped: "replay-mode" }
  | { error: { kind: "unauthorized" | "thread-not-found" } };

// ---------------------------------------------------------------------------
// Main adapter
// ---------------------------------------------------------------------------

/**
 * Adapter that bridges an AG-UI cancel request to `stopThreadInternal()`.
 *
 * Mirrors the shape of `dispatchFollowUpFromAppend` in follow-up-command.ts but
 * is intentionally simpler: no lock (stopThread is idempotent) and no body
 * to parse.
 *
 * Called by `DELETE /api/ag-ui/[threadId]/cancel` after authentication.
 */
export async function cancelThreadFromAgUiInput(args: {
  threadId: string;
  threadChatId: string;
  userId: string;
  isReplayMode: boolean;
}): Promise<CancelResult> {
  const { threadId, threadChatId, userId, isReplayMode } = args;

  // 1. Replay-mode bypass — integration harness recordings must not trigger
  //    real side effects (status transitions, daemon stop messages).
  if (isReplayMode) {
    return { skipped: "replay-mode" };
  }

  // 2. Validate ownership — getThreadChat filters by userId so a miss means
  //    either the thread doesn't exist or the user doesn't own it. We return
  //    the same error in both cases to avoid leaking existence.
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });

  if (!threadChat) {
    return { error: { kind: "unauthorized" } };
  }

  // 3. Call stopThreadInternal directly (bypasses the `userOnlyAction` wrapper
  //    that exists for server-action contexts — we supply the explicit userId).
  await stopThreadInternal({ userId, threadId, threadChatId });

  return { ok: true };
}

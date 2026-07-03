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
  reconciled: boolean;
};

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

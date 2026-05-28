import type { DBMessage } from "@terragon/shared";
import { getAgUiEventEnvelopesForThreadChat } from "@terragon/shared/model/agent-event-log";
import { db } from "@/lib/db";
import { getDurableAgUiHistoryItemsFromEvents } from "@/server-lib/ag-ui-side-effect-messages";
import {
  dropEventsAfterTerminalUntilNextRun,
  toReplayEntriesWithoutTerminalFilter,
  type ReplayEntry,
} from "@/server-lib/ag-ui/ag-ui-replay-planner";
import { mergeMissingDbUserMessagesIntoHistory } from "@/server-lib/ag-ui/ag-ui-user-message-backfill";

export type ThreadHistoryProjection = {
  messages: unknown[];
  lastSeq: number;
  lastCursor?: {
    seq: number;
    projectionIndex: number;
  };
};

export async function projectThreadHistory(params: {
  threadChatId: string;
  dbMessages: readonly DBMessage[];
}): Promise<ThreadHistoryProjection> {
  const { threadChatId, dbMessages } = params;

  const envelopes = await getAgUiEventEnvelopesForThreadChat({
    db,
    threadChatId,
  });
  const historyEntries = dropEventsAfterTerminalUntilNextRun(
    toReplayEntriesWithoutTerminalFilter(envelopes, null),
    { keepInterRunUserAndSystemSnapshots: true },
  );
  const historyEvents = historyEntries.map((entry: ReplayEntry) => entry.event);
  const history = getDurableAgUiHistoryItemsFromEvents(historyEvents);
  const messages = mergeMissingDbUserMessagesIntoHistory({
    historyItems: history.items,
    dbMessages,
  });
  const includedCursor =
    history.lastSeqOffset >= 0
      ? historyEntries[history.lastSeqOffset]
      : undefined;

  return {
    messages,
    lastSeq: includedCursor?.seq ?? -1,
    lastCursor:
      includedCursor?.seq != null &&
      includedCursor.identity?.projectionIndex !== undefined
        ? {
            seq: includedCursor.seq,
            projectionIndex: includedCursor.identity.projectionIndex,
          }
        : undefined,
  };
}

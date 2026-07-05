import { type BaseEvent, EventType, type Message } from "@ag-ui/core";
import type {
  AgUiHistoryItem,
  AgUiHistoryMessagesResult,
} from "@/lib/ag-ui-history-types";
import type { TranscriptStore } from "../transcript-store";

function isCustomEvent(item: AgUiHistoryItem): boolean {
  return (item as { type?: unknown }).type === EventType.CUSTOM;
}

export function hydrateTranscriptFromHistory(
  store: TranscriptStore,
  result: AgUiHistoryMessagesResult,
): void {
  const runId = result.activeRunId ?? null;
  for (const item of result.messages) {
    if (isCustomEvent(item)) {
      store.apply({ payload: item as unknown as BaseEvent, runId });
      continue;
    }
    store.apply({
      payload: {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [item as Message],
      } as unknown as BaseEvent,
      runId,
    });
  }
}

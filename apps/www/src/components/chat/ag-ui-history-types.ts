import type { Message as AgUiMessage } from "@ag-ui/core";
import type { TerragonCustomPartEvent } from "./ag-ui-custom-parts";

export type AgUiHistoryItem = AgUiMessage | TerragonCustomPartEvent;

export type AgUiHistoryMessagesResult = {
  messages: AgUiHistoryItem[];
  lastSeq: number;
};

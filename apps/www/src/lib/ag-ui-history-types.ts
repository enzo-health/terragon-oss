import type { CustomEvent, Message as AgUiMessage } from "@ag-ui/core";

/**
 * Mirrors TerragonCustomPartEvent from components/chat/ag-ui-custom-parts.
 * Defined here (in lib/) so the collections layer can reference it without
 * importing from the components layer.
 */
export type TerragonCustomPartEvent = CustomEvent & {
  readonly name: "terragon.data-part";
};

export type AgUiHistoryItem = AgUiMessage | TerragonCustomPartEvent;

export type AgUiHistoryMessagesResult = {
  messages: AgUiHistoryItem[];
  lastSeq: number;
};

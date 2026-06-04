import type { Message as AgUiMessage, CustomEvent } from "@ag-ui/core";
import type { AgUiReplayCursor } from "./ag-ui-replay-cursor";

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
  lastCursor?: AgUiReplayCursor;
  /**
   * Server-authoritative run liveness at projection time, derived from the
   * durable agent run context (NOT the client status projection). `true` when
   * the thread chat's latest run exists and is non-terminal. Optional so older
   * cached/replay payloads and the synthetic-benchmark + 404-fallback paths
   * stay valid; an `undefined` value means "server did not report" and the
   * resume policy falls back to the client `isAgentWorking` signal.
   */
  runActive?: boolean;
  /** The runId `runActive` was computed against, or null if no run exists. */
  activeRunId?: string | null;
};

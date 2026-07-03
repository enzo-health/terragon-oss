import {
  type BaseEvent,
  EventType,
  type ReasoningMessageEndEvent,
  type ReasoningMessageStartEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
} from "@ag-ui/core";
import { isTerminalRunEventType } from "./ag-ui-replay-planner";
import { getStringEventField } from "./ag-ui-stream-entry";

export type ProtocolMessageChannel = "text" | "reasoning";

export type ProtocolViolationKind =
  | "missing_start_before_content"
  | "orphan_end"
  | "missing_end_at_terminal"
  | "duplicate_run_started"
  | "delayed_run_started"
  | "content_after_terminal";

export const PROTOCOL_VIOLATION_KINDS: readonly ProtocolViolationKind[] = [
  "missing_start_before_content",
  "orphan_end",
  "missing_end_at_terminal",
  "duplicate_run_started",
  "delayed_run_started",
  "content_after_terminal",
];

export function isHardViolation(kind: ProtocolViolationKind): boolean {
  return kind === "content_after_terminal";
}

export type ProtocolViolation = {
  readonly kind: ProtocolViolationKind;
  readonly runId: string;
  readonly eventType: string;
  readonly eventId: string;
  readonly channel?: ProtocolMessageChannel;
  readonly messageId?: string;
};

export type ProtocolRow = {
  readonly event: BaseEvent;
  readonly eventId: string;
};

export type PlannedRow<TRow extends ProtocolRow = ProtocolRow> =
  | { readonly kind: "keep"; readonly row: TRow }
  | {
      readonly kind: "synthetic";
      readonly event: BaseEvent;
      readonly eventId: string;
      readonly reason: ProtocolViolationKind;
    };

export type RunProtocolState = {
  readonly runId: string;
  runStartedCount: number;
  terminalSeen: boolean;
  sawNonSnapshotBeforeRunStarted: boolean;
  readonly openTextMessageIds: Set<string>;
  readonly openReasoningMessageIds: Set<string>;
  readonly openToolCallIds: Set<string>;
};

export function createRunProtocolState(runId: string): RunProtocolState {
  return {
    runId,
    runStartedCount: 0,
    terminalSeen: false,
    sawNonSnapshotBeforeRunStarted: false,
    openTextMessageIds: new Set(),
    openReasoningMessageIds: new Set(),
    openToolCallIds: new Set(),
  };
}

function cloneRunProtocolState(state: RunProtocolState): RunProtocolState {
  return {
    runId: state.runId,
    runStartedCount: state.runStartedCount,
    terminalSeen: state.terminalSeen,
    sawNonSnapshotBeforeRunStarted: state.sawNonSnapshotBeforeRunStarted,
    openTextMessageIds: new Set(state.openTextMessageIds),
    openReasoningMessageIds: new Set(state.openReasoningMessageIds),
    openToolCallIds: new Set(state.openToolCallIds),
  };
}

export type ValidateBatchResult<TRow extends ProtocolRow> = {
  readonly state: RunProtocolState;
  readonly violations: readonly ProtocolViolation[];
  readonly plannedRows: readonly PlannedRow<TRow>[];
};

const TEXT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_CHUNK,
]);
const REASONING_CONTENT_TYPES: ReadonlySet<string> = new Set([
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_CHUNK,
]);

function syntheticTextStart(messageId: string): TextMessageStartEvent {
  return {
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
  } as TextMessageStartEvent;
}

function syntheticReasoningStart(
  messageId: string,
): ReasoningMessageStartEvent {
  return {
    type: EventType.REASONING_MESSAGE_START,
    messageId,
    role: "reasoning",
  } as ReasoningMessageStartEvent;
}

function syntheticTextEnd(messageId: string): TextMessageEndEvent {
  return { type: EventType.TEXT_MESSAGE_END, messageId } as TextMessageEndEvent;
}

function syntheticReasoningEnd(messageId: string): ReasoningMessageEndEvent {
  return {
    type: EventType.REASONING_MESSAGE_END,
    messageId,
  } as ReasoningMessageEndEvent;
}

function syntheticStartEventId(
  runId: string,
  messageId: string,
  channel: ProtocolMessageChannel,
): string {
  return `validator-start:${runId}:${messageId}:${channel}`;
}

function syntheticEndEventId(
  runId: string,
  messageId: string,
  channel: ProtocolMessageChannel,
): string {
  return `validator-end:${runId}:${messageId}:${channel}`;
}

export function validateBatch<TRow extends ProtocolRow>(
  priorState: RunProtocolState,
  rows: readonly TRow[],
): ValidateBatchResult<TRow> {
  const state = cloneRunProtocolState(priorState);
  const violations: ProtocolViolation[] = [];
  const planned: PlannedRow<TRow>[] = [];
  const { runId } = state;

  let firstRunContentPlannedIndex = -1;

  const noteRunContentBeforeStart = (): void => {
    if (state.runStartedCount === 0 && !state.sawNonSnapshotBeforeRunStarted) {
      state.sawNonSnapshotBeforeRunStarted = true;
      firstRunContentPlannedIndex = planned.length;
    }
  };

  const pushViolation = (
    kind: ProtocolViolationKind,
    row: { eventType: string; eventId: string },
    extra?: { channel?: ProtocolMessageChannel; messageId?: string },
  ): void => {
    violations.push({
      kind,
      runId,
      eventType: row.eventType,
      eventId: row.eventId,
      ...(extra?.channel ? { channel: extra.channel } : {}),
      ...(extra?.messageId ? { messageId: extra.messageId } : {}),
    });
  };

  for (const row of rows) {
    const event = row.event;
    const type = String(event.type);
    const eventId = row.eventId;

    if (state.terminalSeen && type !== EventType.RUN_STARTED) {
      pushViolation("content_after_terminal", { eventType: type, eventId });
      continue;
    }

    if (type === EventType.RUN_STARTED) {
      state.runStartedCount += 1;
      if (state.runStartedCount > 1) {
        pushViolation("duplicate_run_started", { eventType: type, eventId });
        state.runStartedCount -= 1;
        continue;
      }
      if (state.sawNonSnapshotBeforeRunStarted) {
        pushViolation("delayed_run_started", { eventType: type, eventId });
        const insertAt =
          firstRunContentPlannedIndex >= 0
            ? firstRunContentPlannedIndex
            : planned.length;
        planned.splice(insertAt, 0, { kind: "keep", row });
      } else {
        planned.push({ kind: "keep", row });
      }
      continue;
    }

    if (isTerminalRunEventType(event.type)) {
      for (const messageId of state.openTextMessageIds) {
        pushViolation(
          "missing_end_at_terminal",
          { eventType: type, eventId },
          { channel: "text", messageId },
        );
        planned.push({
          kind: "synthetic",
          event: syntheticTextEnd(messageId),
          eventId: syntheticEndEventId(runId, messageId, "text"),
          reason: "missing_end_at_terminal",
        });
      }
      for (const messageId of state.openReasoningMessageIds) {
        pushViolation(
          "missing_end_at_terminal",
          { eventType: type, eventId },
          { channel: "reasoning", messageId },
        );
        planned.push({
          kind: "synthetic",
          event: syntheticReasoningEnd(messageId),
          eventId: syntheticEndEventId(runId, messageId, "reasoning"),
          reason: "missing_end_at_terminal",
        });
      }
      state.openTextMessageIds.clear();
      state.openReasoningMessageIds.clear();
      planned.push({ kind: "keep", row });
      state.terminalSeen = true;
      continue;
    }

    if (type === EventType.MESSAGES_SNAPSHOT) {
      planned.push({ kind: "keep", row });
      continue;
    }

    if (type === EventType.TEXT_MESSAGE_START) {
      const messageId = getStringEventField(event, "messageId");
      if (messageId !== null) {
        state.openTextMessageIds.add(messageId);
      }
      noteRunContentBeforeStart();
      planned.push({ kind: "keep", row });
      continue;
    }

    if (type === EventType.REASONING_MESSAGE_START) {
      const messageId = getStringEventField(event, "messageId");
      if (messageId !== null) {
        state.openReasoningMessageIds.add(messageId);
      }
      noteRunContentBeforeStart();
      planned.push({ kind: "keep", row });
      continue;
    }

    if (TEXT_CONTENT_TYPES.has(type)) {
      const messageId = getStringEventField(event, "messageId");
      noteRunContentBeforeStart();
      if (messageId !== null && !state.openTextMessageIds.has(messageId)) {
        pushViolation(
          "missing_start_before_content",
          { eventType: type, eventId },
          { channel: "text", messageId },
        );
        planned.push({
          kind: "synthetic",
          event: syntheticTextStart(messageId),
          eventId: syntheticStartEventId(runId, messageId, "text"),
          reason: "missing_start_before_content",
        });
        state.openTextMessageIds.add(messageId);
      }
      planned.push({ kind: "keep", row });
      continue;
    }

    if (REASONING_CONTENT_TYPES.has(type)) {
      const messageId = getStringEventField(event, "messageId");
      noteRunContentBeforeStart();
      if (messageId !== null && !state.openReasoningMessageIds.has(messageId)) {
        pushViolation(
          "missing_start_before_content",
          { eventType: type, eventId },
          { channel: "reasoning", messageId },
        );
        planned.push({
          kind: "synthetic",
          event: syntheticReasoningStart(messageId),
          eventId: syntheticStartEventId(runId, messageId, "reasoning"),
          reason: "missing_start_before_content",
        });
        state.openReasoningMessageIds.add(messageId);
      }
      planned.push({ kind: "keep", row });
      continue;
    }

    if (type === EventType.TEXT_MESSAGE_END) {
      const messageId = getStringEventField(event, "messageId");
      noteRunContentBeforeStart();
      if (messageId === null || !state.openTextMessageIds.has(messageId)) {
        pushViolation(
          "orphan_end",
          { eventType: type, eventId },
          {
            channel: "text",
            ...(messageId !== null ? { messageId } : {}),
          },
        );
        continue;
      }
      state.openTextMessageIds.delete(messageId);
      planned.push({ kind: "keep", row });
      continue;
    }

    if (type === EventType.REASONING_MESSAGE_END) {
      const messageId = getStringEventField(event, "messageId");
      noteRunContentBeforeStart();
      if (messageId === null || !state.openReasoningMessageIds.has(messageId)) {
        pushViolation(
          "orphan_end",
          { eventType: type, eventId },
          {
            channel: "reasoning",
            ...(messageId !== null ? { messageId } : {}),
          },
        );
        continue;
      }
      state.openReasoningMessageIds.delete(messageId);
      planned.push({ kind: "keep", row });
      continue;
    }

    if (type === EventType.TOOL_CALL_START) {
      const toolCallId = getStringEventField(event, "toolCallId");
      if (toolCallId !== null) {
        state.openToolCallIds.add(toolCallId);
      }
      noteRunContentBeforeStart();
      planned.push({ kind: "keep", row });
      continue;
    }

    if (type === EventType.TOOL_CALL_END) {
      const toolCallId = getStringEventField(event, "toolCallId");
      if (toolCallId !== null) {
        state.openToolCallIds.delete(toolCallId);
      }
      noteRunContentBeforeStart();
      planned.push({ kind: "keep", row });
      continue;
    }

    noteRunContentBeforeStart();
    planned.push({ kind: "keep", row });
  }

  return { state, violations, plannedRows: planned };
}

export function foldRows(
  runId: string,
  rows: readonly ProtocolRow[],
): RunProtocolState {
  return validateBatch(createRunProtocolState(runId), rows).state;
}

export type ProtocolViolationCounts = Record<ProtocolViolationKind, number>;

export function emptyViolationCounts(): ProtocolViolationCounts {
  return {
    missing_start_before_content: 0,
    orphan_end: 0,
    missing_end_at_terminal: 0,
    duplicate_run_started: 0,
    delayed_run_started: 0,
    content_after_terminal: 0,
  };
}

export function countViolations(
  violations: readonly ProtocolViolation[],
): ProtocolViolationCounts {
  const counts = emptyViolationCounts();
  for (const violation of violations) {
    counts[violation.kind] += 1;
  }
  return counts;
}

export type ProtocolValidationMode = "off" | "observe" | "enforce";

export const PROTOCOL_VALIDATION_ENV_VAR = "AGUI_WRITE_PROTOCOL_VALIDATION";

export function getProtocolValidationMode(
  env: Record<string, string | undefined> = process.env,
): ProtocolValidationMode {
  const raw = env[PROTOCOL_VALIDATION_ENV_VAR]?.trim().toLowerCase();
  if (raw === "off" || raw === "enforce") {
    return raw;
  }
  return "observe";
}

export class RunProtocolStateStore {
  private readonly states = new Map<string, RunProtocolState>();

  get(runId: string): RunProtocolState | undefined {
    return this.states.get(runId);
  }

  getOrRecover(
    runId: string,
    recover: () => readonly ProtocolRow[],
  ): RunProtocolState {
    const existing = this.states.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const recovered = foldRows(runId, recover());
    this.states.set(runId, recovered);
    return recovered;
  }

  set(runId: string, state: RunProtocolState): void {
    this.states.set(runId, state);
  }

  delete(runId: string): void {
    this.states.delete(runId);
  }
}

export const PROTOCOL_VALIDATION_LOG_PREFIX = "[agui-write-validation]";

export type ProtocolValidationDiagnostic = {
  runId: string;
  threadChatId: string;
  mode: ProtocolValidationMode;
  attempted: number;
  totalViolations: number;
  hardViolations: number;
  counts: ProtocolViolationCounts;
};

type ProtocolValidationSink = (
  diagnostic: ProtocolValidationDiagnostic,
) => void;

declare global {
  var __terragonAgUiWriteValidationSink: ProtocolValidationSink | undefined;
}

export function emitProtocolValidationDiagnostic(
  diagnostic: ProtocolValidationDiagnostic,
): void {
  if (diagnostic.totalViolations === 0) {
    return;
  }
  globalThis.__terragonAgUiWriteValidationSink?.(diagnostic);
  console.info(PROTOCOL_VALIDATION_LOG_PREFIX, diagnostic);
}

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

/**
 * Write-time AG-UI protocol validator.
 *
 * The durable `agent_event_log` is not trusted at read time: every SSE
 * connection re-repairs protocol compliance through the read-time band in
 * `ag-ui-replay-planner.ts` (`repairReplayTextMessageLifecycles`,
 * `repairDelayedRunStartedOrdering`, `dropDuplicateRunStarted`,
 * `dropEventsAfterTerminalUntilNextRun`). This module mirrors that band's
 * repair semantics as a per-run incremental state machine that runs on the
 * WRITE path instead, so the log can eventually be trusted and the read-time
 * band deleted (plan §3 Tier-3, Wave 5).
 *
 * ## Repair-semantics mapping (read-time band -> validator equivalent)
 *
 * | read-time repair (ag-ui-replay-planner.ts)                     | validator violation kind + repair                                              |
 * | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
 * | `repairReplayTextMessageLifecycles`: CONTENT w/o open START    | `missing_start_before_content`: synthesize *_MESSAGE_START before the CONTENT  |
 * | `repairReplayTextMessageLifecycles`: END w/o open START (drop)  | `orphan_end`: drop the END row                                                 |
 * | route `buildDeltaRunEndRows` at terminal (write-side already)   | `missing_end_at_terminal`: synthesize *_MESSAGE_END before the terminal        |
 * | `dropDuplicateRunStarted`: 2nd+ RUN_STARTED in a run (drop)     | `duplicate_run_started`: drop the extra RUN_STARTED                            |
 * | `repairDelayedRunStartedOrdering`: RUN_STARTED not first (move) | `delayed_run_started`: reorder RUN_STARTED ahead of leading run content        |
 * | `dropEventsAfterTerminalUntilNextRun`: event after terminal    | `content_after_terminal` (HARD): drop the row                                  |
 *
 * The 6-level `getReplayDedupeKey` cascade has NO validator equivalent by
 * design: it dedupes the same durable event arriving twice across the
 * replay-from-seq / Redis-live-tail seam (a read-path artifact). The durable
 * log holds each event exactly once — `persistAgUiEvents` already enforces
 * that via the `(runId, eventId)` unique index and monotonic seq assignment —
 * so there is nothing to dedupe at write time.
 */

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

/**
 * Only `content_after_terminal` is a hard violation: an event after a run's
 * terminal marker is unrecoverable corruption (AG-UI `verifyEvents` throws on
 * it client-side), so enforce mode drops it. Every other kind is a benign
 * lifecycle repair that produces a still-complete stream.
 */
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

/**
 * Minimal shape the validator needs from a persist row. Decoupled from
 * `AgUiPublishRow` so the module has no dependency on `ag-ui-publisher.ts`
 * (the wiring point); the caller maps its rows to/from this shape.
 */
export type ProtocolRow = {
  readonly event: BaseEvent;
  readonly eventId: string;
};

/**
 * A row in the enforce-mode output. `keep` carries the caller's original row
 * (generic `TRow`) so no data is lost round-tripping through the validator;
 * `synthetic` is a repair row the caller must persist in this position.
 * Dropped rows are simply absent from the planned list.
 */
export type PlannedRow<TRow extends ProtocolRow = ProtocolRow> =
  | { readonly kind: "keep"; readonly row: TRow }
  | {
      readonly kind: "synthetic";
      readonly event: BaseEvent;
      readonly eventId: string;
      readonly reason: ProtocolViolationKind;
    };

/**
 * Per-run protocol state. Resumable across POST batches: fold prior rows for
 * the run through `foldRows` to reconstruct it on a cache miss (the fields are
 * a pure function of the run's row prefix).
 */
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
  /** The advanced state; pass it to the next batch for the same run. */
  readonly state: RunProtocolState;
  readonly violations: readonly ProtocolViolation[];
  /** Enforce-mode persist plan (in order). Ignored by observe mode. */
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

/**
 * Deterministic eventIds for synthetic repair rows so retried batches dedupe
 * on `(runId, eventId)` — the first writer wins, later attempts are no-ops in
 * the persist layer (same scheme as the daemon delta START/END rows).
 */
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

/**
 * Fold a batch of rows for a single run through the protocol state machine.
 *
 * Pure: does not mutate the passed `state` (it is cloned). Mirrors the
 * composition the read-time band applies in `toReplayEntries`
 * (`dropEventsAfterTerminalUntilNextRun ∘ repairDelayedRunStartedOrdering`)
 * followed by `repairReplayTextMessageLifecycles`, plus the write-side
 * terminal END synthesis the route performs today via `buildDeltaRunEndRows`.
 */
export function validateBatch<TRow extends ProtocolRow>(
  priorState: RunProtocolState,
  rows: readonly TRow[],
): ValidateBatchResult<TRow> {
  const state = cloneRunProtocolState(priorState);
  const violations: ProtocolViolation[] = [];
  const planned: PlannedRow<TRow>[] = [];
  const { runId } = state;

  // Index in `planned` of the first row that counts as run content (i.e. not a
  // leading MESSAGES_SNAPSHOT) seen before the run's first RUN_STARTED. Used to
  // reorder a delayed RUN_STARTED ahead of that content, mirroring
  // repairSingleRunStartedOrdering.
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

    // Content-after-terminal (hard): everything except a fresh RUN_STARTED is
    // dropped once the run has a terminal marker. Mirrors
    // dropEventsAfterTerminalUntilNextRun (which drops until the next run) and
    // AG-UI verifyEvents' "no events after terminal" invariant.
    if (state.terminalSeen && type !== EventType.RUN_STARTED) {
      pushViolation("content_after_terminal", { eventType: type, eventId });
      continue;
    }

    if (type === EventType.RUN_STARTED) {
      state.runStartedCount += 1;
      if (state.runStartedCount > 1) {
        // Duplicate RUN_STARTED for the same run — drop (dropDuplicateRunStarted).
        // A RUN_STARTED that arrives after a terminal also lands here (count > 1)
        // and is dropped, matching the band's composition order.
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
      // Close any delta-opened text/reasoning lifecycles before the terminal —
      // the same rows the route persists via buildDeltaRunEndRows today.
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
      // Snapshots are allowed to lead a run (they do not force RUN_STARTED
      // reordering), so they do not count as pre-run content.
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

    // Any other run content (TOOL_CALL_ARGS/CHUNK/RESULT, CUSTOM, ...): kept
    // verbatim; it still counts as pre-run content for delayed-RUN_STARTED
    // detection.
    noteRunContentBeforeStart();
    planned.push({ kind: "keep", row });
  }

  return { state, violations, plannedRows: planned };
}

/**
 * Recovery constructor: reconstruct a run's state by folding its prior rows.
 * Used when the in-memory state store misses (cold start, eviction). The
 * result is independent of enforce/observe mode because the state fields are a
 * pure function of the row prefix.
 */
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

// ---------------------------------------------------------------------------
// Mode selection + cross-batch state store (wiring helpers)
// ---------------------------------------------------------------------------

export type ProtocolValidationMode = "off" | "observe" | "enforce";

export const PROTOCOL_VALIDATION_ENV_VAR = "AGUI_WRITE_PROTOCOL_VALIDATION";

/**
 * Read the write-time protocol-validation mode from the environment.
 *
 * Default `observe`: count would-be repairs (plan §8 risk 2 — "observe mode
 * first, count would-be repairs, then enforce") without changing what is
 * persisted. `enforce` applies the repairs and drops hard violations. `off`
 * disables the validator entirely.
 *
 * An env var (not a per-user feature flag) is used deliberately: this is a
 * process-level write-path decision on the daemon-event route, where no user
 * scope is naturally in hand, and it must be uniform across a deploy.
 */
export function getProtocolValidationMode(
  env: Record<string, string | undefined> = process.env,
): ProtocolValidationMode {
  const raw = env[PROTOCOL_VALIDATION_ENV_VAR]?.trim().toLowerCase();
  if (raw === "off" || raw === "enforce") {
    return raw;
  }
  return "observe";
}

/**
 * In-memory per-run state, keyed by runId, with `foldRows` recovery on miss.
 *
 * Multi-instance caveat: this store is per process. The daemon-event route is
 * effectively single-writer per thread chat (seq assignment holds a
 * transaction-scoped advisory lock keyed on the thread chat), so a given run's
 * batches serialize even across instances — but they may land on DIFFERENT
 * instances, each with a cold store. Recovery is therefore mandatory, not
 * optional: on a miss the caller MUST fold the run's already-persisted rows
 * (e.g. via `getAgUiEventEnvelopesForRun`) through `foldRows` before validating
 * the incoming batch. The store is a latency optimization over that fold, never
 * the source of truth.
 */
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

// ---------------------------------------------------------------------------
// Observe-mode diagnostics
// ---------------------------------------------------------------------------

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
  // eslint-disable-next-line no-var
  var __terragonAgUiWriteValidationSink: ProtocolValidationSink | undefined;
}

/**
 * Emit one structured line per batch that had any violation. Follows the
 * `emitStreamDiagnostic` console pattern (stable prefix + structured payload)
 * so production log queries can quantify would-be repairs before enforcement
 * is switched on. A global sink is honored first so tests can capture without
 * scraping stdout.
 */
export function emitProtocolValidationDiagnostic(
  diagnostic: ProtocolValidationDiagnostic,
): void {
  if (diagnostic.totalViolations === 0) {
    return;
  }
  globalThis.__terragonAgUiWriteValidationSink?.(diagnostic);
  console.info(PROTOCOL_VALIDATION_LOG_PREFIX, diagnostic);
}

import { type BaseEvent, EventType } from "@ag-ui/core";
import { mapRunErrorToAgui } from "@terragon/agent/ag-ui-mapper";
import { recordAgentTraceSpan } from "@/lib/agent-trace";
import {
  buildResumeRunStartedEvent,
  getReplayDedupeKey,
  getReplayEntryRunId,
  isTerminalRunEventType,
  sseIdForReplayEntry,
  type ReplayEntry,
} from "@/server-lib/ag-ui/ag-ui-replay-planner";
import {
  encodeSseComment,
  encodeSseEvent,
  emitStreamDiagnostic,
  type StreamCloseReason,
  type StreamDiagnostics,
  BASELINE_SNAPSHOT_COMMENT,
} from "@/server-lib/ag-ui/ag-ui-sse-writer";
import {
  getStringEventField,
  isValidKnownAgUiEvent,
  type ReplayIdentity,
} from "@/server-lib/ag-ui/ag-ui-stream-entry";

export class AgUiSseSession {
  private controller: ReadableStreamDefaultController<Uint8Array>;
  private diagnostics: StreamDiagnostics;
  private _closed = false;
  private _closeReason: StreamCloseReason | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;

  // Dedup tracking: replayed events are remembered so live-tail overlap
  // can skip duplicates.
  private replayedEventDedupeKeys = new Set<string>();

  // State tracking for event emission
  lastDeliveredSeq: number | null;
  hasEmittedAgUiDataEvent = false;
  activeEmittedRunId: string | null = null;
  resolvedRunId: string | null;

  // External context
  readonly threadId: string;
  readonly threadChatId: string;
  readonly userId: string;
  readonly replayCursorSeq: number | null;
  readonly shouldFrameRunAgentResume: boolean;

  constructor(params: {
    controller: ReadableStreamDefaultController<Uint8Array>;
    threadId: string;
    threadChatId: string;
    userId: string;
    resolvedRunId: string | null;
    replayCursorSeq: number | null;
    shouldFrameRunAgentResume: boolean;
    hasRunIdParam: boolean;
  }) {
    this.controller = params.controller;
    this.threadId = params.threadId;
    this.threadChatId = params.threadChatId;
    this.userId = params.userId;
    this.resolvedRunId = params.resolvedRunId;
    this.replayCursorSeq = params.replayCursorSeq;
    this.shouldFrameRunAgentResume = params.shouldFrameRunAgentResume;
    this.lastDeliveredSeq = params.replayCursorSeq;

    this.diagnostics = {
      openedAtMs: Date.now(),
      firstFrameLatencyMs: null,
      replayCount: 0,
      dedupeCount: 0,
      xreadTimeoutCount: 0,
      xreadBackoffCount: 0,
      xreadErrorCount: 0,
    };

    emitStreamDiagnostic("stream_open", {
      threadId: this.threadId,
      threadChatId: this.threadChatId,
      runId: this.resolvedRunId,
      hasRunIdParam: params.hasRunIdParam,
      replayCursorSeq: this.replayCursorSeq,
    });
    recordAgentTraceSpan({
      traceId: this.resolvedRunId,
      name: "server.agui.sse.opened",
      startedAtMs: this.diagnostics.openedAtMs,
      endedAtMs: this.diagnostics.openedAtMs,
      attributes: {
        threadId: this.threadId,
        threadChatId: this.threadChatId,
        hasRunIdParam: params.hasRunIdParam,
        replayCursorSeq: this.replayCursorSeq,
      },
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  get closeReason(): StreamCloseReason | null {
    return this._closeReason;
  }

  get diagnosticsSnapshot(): Readonly<StreamDiagnostics> {
    return { ...this.diagnostics };
  }

  close(reason: StreamCloseReason): void {
    if (this._closed) return;
    this._closed = true;
    this._closeReason = reason;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    try {
      this.controller.close();
    } catch {
      // already closed
    }
    emitStreamDiagnostic("stream_close", {
      threadId: this.threadId,
      threadChatId: this.threadChatId,
      runId: this.resolvedRunId,
      closeReason: reason,
      firstFrameLatencyMs: this.diagnostics.firstFrameLatencyMs,
      replayCount: this.diagnostics.replayCount,
      dedupeCount: this.diagnostics.dedupeCount,
      xreadTimeoutCount: this.diagnostics.xreadTimeoutCount,
      xreadBackoffCount: this.diagnostics.xreadBackoffCount,
      xreadErrorCount: this.diagnostics.xreadErrorCount,
    });
    recordAgentTraceSpan({
      traceId: this.resolvedRunId,
      name: "server.agui.sse.closed",
      startedAtMs: this.diagnostics.openedAtMs,
      endedAtMs: Date.now(),
      attributes: {
        threadId: this.threadId,
        threadChatId: this.threadChatId,
        closeReason: reason,
        replayCount: this.diagnostics.replayCount,
        dedupeCount: this.diagnostics.dedupeCount,
        xreadTimeoutCount: this.diagnostics.xreadTimeoutCount,
        xreadBackoffCount: this.diagnostics.xreadBackoffCount,
        xreadErrorCount: this.diagnostics.xreadErrorCount,
      },
    });
  }

  enqueue(chunk: Uint8Array): void {
    if (this._closed) return;
    try {
      this.markFirstFrameIfNeeded();
      this.controller.enqueue(chunk);
    } catch {
      this.close("controller_enqueue_failed");
    }
  }

  setKeepaliveTimer(timer: NodeJS.Timeout): void {
    this.keepaliveTimer = timer;
  }

  incrementReplayCount(): void {
    this.diagnostics.replayCount += 1;
  }

  incrementDedupeCount(): void {
    this.diagnostics.dedupeCount += 1;
  }

  incrementXreadErrorCount(): void {
    this.diagnostics.xreadErrorCount += 1;
  }

  incrementXreadBackoffCount(): void {
    this.diagnostics.xreadBackoffCount += 1;
  }

  incrementXreadTimeoutCount(): void {
    this.diagnostics.xreadTimeoutCount += 1;
  }

  getXreadErrorCount(): number {
    return this.diagnostics.xreadErrorCount;
  }

  emitBaselineComment(): void {
    this.enqueue(encodeSseComment(BASELINE_SNAPSHOT_COMMENT));
  }

  rememberReplayedEventDedupeKeys(
    event: BaseEvent,
    identity?: ReplayIdentity,
  ): void {
    const dedupeKey = getReplayDedupeKey(event, identity);
    if (dedupeKey !== null) {
      this.replayedEventDedupeKeys.add(dedupeKey);
    }
    if (identity !== undefined) {
      const structuralDedupeKey = getReplayDedupeKey(event);
      if (structuralDedupeKey !== null) {
        this.replayedEventDedupeKeys.add(structuralDedupeKey);
      }
    }
  }

  consumeReplayedEventDedupeKey(
    event: BaseEvent,
    identity?: ReplayIdentity,
  ): boolean {
    const dedupeKey = getReplayDedupeKey(event, identity);
    if (dedupeKey !== null && this.replayedEventDedupeKeys.has(dedupeKey)) {
      this.replayedEventDedupeKeys.delete(dedupeKey);
      return true;
    }
    if (identity !== undefined) {
      const structuralDedupeKey = getReplayDedupeKey(event);
      if (
        structuralDedupeKey !== null &&
        this.replayedEventDedupeKeys.has(structuralDedupeKey)
      ) {
        this.replayedEventDedupeKeys.delete(structuralDedupeKey);
        return true;
      }
    }
    return false;
  }

  /**
   * Emit an AG-UI event to the SSE stream with proper run-lifecycle
   * management (auto-close previous runs, track active run).
   */
  emitAgUiEvent(
    event: BaseEvent,
    seq: number | null,
    identity?: ReplayIdentity,
  ): boolean {
    if (!this.ensurePostResumeStartsWithRun(event, identity)) {
      return false;
    }
    if (event.type === EventType.RUN_STARTED) {
      const nextRunId = getStringEventField(event, "runId");
      if (
        this.activeEmittedRunId !== null &&
        nextRunId !== null &&
        this.activeEmittedRunId !== nextRunId
      ) {
        this.enqueue(
          encodeSseEvent({
            type: EventType.RUN_FINISHED,
            threadId: this.threadId,
            runId: this.activeEmittedRunId,
          }),
        );
      }
      this.activeEmittedRunId = nextRunId;
      this.resolvedRunId = nextRunId;
    }
    this.hasEmittedAgUiDataEvent = true;
    this.enqueue(encodeSseEvent(event, sseIdForReplayEntry(seq, identity)));
    if (isTerminalRunEventType(event.type)) {
      const terminalRunId = getStringEventField(event, "runId");
      if (terminalRunId === null || terminalRunId === this.activeEmittedRunId) {
        this.activeEmittedRunId = null;
      }
    }
    return true;
  }

  /**
   * Emit a replay entry after validation.
   */
  emitReplayEntry(entry: ReplayEntry): boolean {
    if (!isValidKnownAgUiEvent(entry.event)) {
      console.error("[ag-ui] threadChat replay: malformed AG-UI event", {
        threadId: this.threadId,
        threadChatId: this.threadChatId,
        runId: this.resolvedRunId,
        eventType: Reflect.get(entry.event, "type"),
        seq: entry.seq,
      });
      const errorEvent = mapRunErrorToAgui(
        `Run ${this.resolvedRunId} log contains malformed AG-UI event at seq ${entry.seq ?? "unknown"}`,
        "replay_failed",
      );
      this.emitAgUiEvent(errorEvent, null);
      this.close("malformed_replay");
      return false;
    }

    this.incrementReplayCount();
    this.rememberReplayedEventDedupeKeys(entry.event, entry.identity);
    if (entry.seq !== null) {
      this.lastDeliveredSeq =
        this.lastDeliveredSeq === null
          ? entry.seq
          : Math.max(this.lastDeliveredSeq, entry.seq);
    }
    return this.emitAgUiEvent(entry.event, entry.seq, entry.identity);
  }

  frameResumeReplayEntries(replayEntries: ReplayEntry[]): boolean {
    if (
      this.replayCursorSeq === null ||
      !this.shouldFrameRunAgentResume ||
      replayEntries.length === 0
    ) {
      return true;
    }

    while (replayEntries[0]?.event.type === EventType.MESSAGES_SNAPSHOT) {
      const [entry] = replayEntries.splice(0, 1);
      if (entry?.seq !== null && entry?.seq !== undefined) {
        this.lastDeliveredSeq =
          this.lastDeliveredSeq === null
            ? entry.seq
            : Math.max(this.lastDeliveredSeq, entry.seq);
      }
    }

    if (
      replayEntries.length === 0 ||
      replayEntries[0]?.event.type === EventType.RUN_STARTED
    ) {
      return true;
    }

    const resumeRunId =
      this.resolvedRunId ??
      (replayEntries[0] ? getReplayEntryRunId(replayEntries[0]) : null);
    if (resumeRunId === null) {
      console.error(
        "[ag-ui] cursored resume cannot infer run id for synthetic RUN_STARTED",
        {
          threadId: this.threadId,
          threadChatId: this.threadChatId,
          firstType: replayEntries[0]?.event.type,
        },
      );
      const errorEvent = mapRunErrorToAgui(
        `Thread chat ${this.threadChatId} resume log is malformed: first event has no run id`,
        "replay_failed",
      );
      this.enqueue(encodeSseEvent(errorEvent));
      this.close("malformed_replay");
      return false;
    }

    this.resolvedRunId = resumeRunId;
    replayEntries.unshift({
      seq: null,
      event: buildResumeRunStartedEvent({
        threadId: this.threadId,
        runId: resumeRunId,
      }),
    });
    let syntheticFrameIsTerminal = false;
    for (let index = 1; index < replayEntries.length; index += 1) {
      const entry = replayEntries[index]!;
      const entryRunId = getReplayEntryRunId(entry);
      if (
        entry.event.type === EventType.RUN_STARTED &&
        entryRunId === resumeRunId
      ) {
        replayEntries.splice(index, 1);
        index -= 1;
        continue;
      }
      if (
        !syntheticFrameIsTerminal &&
        entry.event.type === EventType.RUN_STARTED &&
        entryRunId !== null &&
        entryRunId !== resumeRunId
      ) {
        replayEntries.splice(index, 0, {
          seq: null,
          event: {
            type: EventType.RUN_FINISHED,
            threadId: this.threadId,
            runId: resumeRunId,
          },
        });
        syntheticFrameIsTerminal = true;
        index += 1;
        continue;
      }
      if (
        entryRunId === resumeRunId &&
        isTerminalRunEventType(entry.event.type)
      ) {
        syntheticFrameIsTerminal = true;
      }
    }
    return true;
  }

  private markFirstFrameIfNeeded(): void {
    if (this.diagnostics.firstFrameLatencyMs !== null) {
      return;
    }
    this.diagnostics.firstFrameLatencyMs =
      Date.now() - this.diagnostics.openedAtMs;
    emitStreamDiagnostic("first_frame", {
      threadId: this.threadId,
      threadChatId: this.threadChatId,
      runId: this.resolvedRunId,
      firstFrameLatencyMs: this.diagnostics.firstFrameLatencyMs,
    });
    recordAgentTraceSpan({
      traceId: this.resolvedRunId,
      name: "server.agui.sse.first_frame",
      startedAtMs: this.diagnostics.openedAtMs,
      endedAtMs: Date.now(),
      attributes: {
        threadId: this.threadId,
        threadChatId: this.threadChatId,
        firstFrameLatencyMs: this.diagnostics.firstFrameLatencyMs,
      },
    });
  }

  private ensurePostResumeStartsWithRun(
    event: BaseEvent,
    identity?: ReplayIdentity,
  ): boolean {
    if (
      !this.shouldFrameRunAgentResume ||
      this.hasEmittedAgUiDataEvent ||
      event.type === EventType.RUN_STARTED ||
      event.type === EventType.RUN_ERROR
    ) {
      return true;
    }

    const resumeRunId =
      this.resolvedRunId ??
      identity?.runId ??
      getStringEventField(event, "runId");
    if (resumeRunId === null) {
      console.error(
        "[ag-ui] cursored resume cannot infer run id before first live event",
        {
          threadId: this.threadId,
          threadChatId: this.threadChatId,
          firstType: event.type,
        },
      );
      const errorEvent = mapRunErrorToAgui(
        `Thread chat ${this.threadChatId} resume log is malformed: first event has no run id`,
        "replay_failed",
      );
      this.hasEmittedAgUiDataEvent = true;
      this.enqueue(encodeSseEvent(errorEvent));
      this.close("malformed_replay");
      return false;
    }

    this.resolvedRunId = resumeRunId;
    const runStartedEvent = buildResumeRunStartedEvent({
      threadId: this.threadId,
      runId: resumeRunId,
    });
    this.rememberReplayedEventDedupeKeys(runStartedEvent);
    this.hasEmittedAgUiDataEvent = true;
    this.activeEmittedRunId = resumeRunId;
    this.enqueue(encodeSseEvent(runStartedEvent));
    return true;
  }
}

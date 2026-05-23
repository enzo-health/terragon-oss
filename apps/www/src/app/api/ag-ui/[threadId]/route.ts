import {
  type BaseEvent,
  EventType,
  type Message,
  type MessagesSnapshotEvent,
  RunAgentInputSchema,
} from "@ag-ui/core";
import { mapRunErrorToAgui } from "@terragon/agent/ag-ui-mapper";
import type { DBMessage } from "@terragon/shared";
import * as schema from "@terragon/shared/db/schema";
import {
  type AgUiEventEnvelope,
  type AgUiTraceMetadata,
  agUiStreamKey,
  getAgUiEventEnvelopesForRun,
  getAgUiEventEnvelopesForThreadChat,
  getLatestRunIdForThreadChat,
  isTerminalAgentRunStatus,
} from "@terragon/shared/model/agent-event-log";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getSessionOrNull } from "@/lib/auth-server";
import {
  getTraceIdFromAgUiForwardedProps,
  recordAgentTraceSpan,
} from "@/lib/agent-trace";
import { db } from "@/lib/db";
import { isLocalRedisHttpMode, redis } from "@/lib/redis";
import {
  dbMessagesToNativeAgUiSnapshotMessages,
  type DurableAgUiHistoryItem,
  getDurableAgUiHistoryItemsFromEvents,
} from "@/server-lib/ag-ui-side-effect-messages";
import { buildRunTerminalAgUi } from "@/server-lib/ag-ui-publisher";
import { runFollowUpFromAgUiInput } from "@/server-lib/run-from-ag-ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long-lived SSE stream: request up to 5 minutes of serverless execution
// time (Vercel Pro cap). Client-side aborts close the stream early, so
// typical usage will not hit this ceiling.
export const maxDuration = 300;

// XREAD poll tuning. Adaptive backoff: start at MIN_XREAD_BLOCK_MS and
// grow linearly up to MAX_XREAD_BLOCK_MS while the stream is idle, then
// reset on any received event. This cuts Upstash read costs on long-idle
// SSE streams without trading off live-tail latency on active threads.
//
// Note: production Upstash HTTP timeout permits up to ~30s block windows;
// dev's resilient-redis client caps at ~3s (localHttpCommandTimeoutMs)
// so the MIN value stays under that ceiling to avoid noisy warnings.
const MIN_XREAD_BLOCK_MS = 2_000;
const MAX_XREAD_BLOCK_MS = 10_000;
const XREAD_COUNT = 32;
const KEEPALIVE_INTERVAL_MS = 15_000;
const XREAD_BACKOFF_MS = 1_000;
const BASELINE_SNAPSHOT_COMMENT = "baseline-snapshot";
// When Redis live-tail misses the daemon's terminal marker, we still need to
// converge on terminal truth once durable run status flips. Tie checks to idle
// polls (not wall-clock time) so tests stay deterministic.
const TERMINAL_STATUS_CHECK_EVERY_EMPTY_POLLS = 2;

const ENCODER = new TextEncoder();
const AG_UI_EVENT_TYPES: ReadonlySet<unknown> = new Set(
  Object.values(EventType),
);

type AgUiStreamEntry = {
  id: string;
  seq: number | null;
  event: BaseEvent | null;
  identity?: ReplayIdentity;
};

type ReplayEntry = {
  seq: number | null;
  event: BaseEvent;
  identity?: ReplayIdentity;
};

type ReplayIdentity = {
  runId?: string;
  eventId?: string;
  idempotencyKey?: string;
  seq?: number;
  projectionIndex?: number;
  projectionCount?: number;
  trace?: AgUiTraceMetadata;
};

type TerragonTraceSidebandValue = {
  schemaVersion: 1;
  kind: "terragon.trace.daemon_event.received";
  runId?: string;
  eventId?: string;
  seq?: number;
  projectionIndex?: number;
  projectionCount?: number;
  daemonEventId: string | null;
  daemonEventReceivedAtMs: number;
};

type ReplayCursor = {
  seq: number;
  projectionIndex: number | null;
};

type AgUiUserMessage = Extract<Message, { role: "user" }>;
type TerragonPostIntent = "append" | "resume";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTerragonPostIntent(forwardedProps: unknown): TerragonPostIntent {
  const runConfig = isRecord(forwardedProps)
    ? (forwardedProps["runConfig"] ?? null)
    : null;
  const terragon = isRecord(runConfig)
    ? (runConfig["terragon"] ?? null)
    : isRecord(forwardedProps)
      ? (forwardedProps["terragon"] ?? null)
      : null;
  if (!isRecord(terragon)) return "append";
  return terragon["intent"] === "resume" ? "resume" : "append";
}

function isAgUiUserMessage(
  item: DurableAgUiHistoryItem,
): item is AgUiUserMessage {
  return Reflect.get(item, "role") === "user";
}

function agUiMessageContentText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part === null || typeof part !== "object") {
        return "";
      }
      const type = Reflect.get(part, "type");
      const text = Reflect.get(part, "text");
      return type === "text" && typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

function mergeMissingDbUserMessagesIntoHistory({
  historyItems,
  dbMessages,
}: {
  historyItems: DurableAgUiHistoryItem[];
  dbMessages: readonly DBMessage[];
}): DurableAgUiHistoryItem[] {
  const historyUserIndicesBySignature = new Map<string, number[]>();
  historyItems.forEach((item, index) => {
    if (!isAgUiUserMessage(item)) {
      return;
    }
    const signature = agUiUserMessageSignature(item);
    const indices = historyUserIndicesBySignature.get(signature) ?? [];
    indices.push(index);
    historyUserIndicesBySignature.set(signature, indices);
  });

  const missingBeforeIndex = new Map<number, AgUiUserMessage[]>();
  const missingAfterIndex = new Map<number, AgUiUserMessage[]>();
  const pendingMissingUserMessages: AgUiUserMessage[] = [];
  let lastMatchedHistoryIndex: number | null = null;

  for (const message of dbMessagesToNativeAgUiSnapshotMessages(dbMessages)) {
    if (!isAgUiUserMessage(message)) {
      continue;
    }
    const content = agUiMessageContentText(message.content);
    if (content.length === 0) {
      continue;
    }
    const matchingHistoryIndices = historyUserIndicesBySignature.get(
      agUiUserMessageSignature(message),
    );
    const matchingHistoryIndex = matchingHistoryIndices?.shift();
    if (matchingHistoryIndex === undefined) {
      pendingMissingUserMessages.push(message);
      continue;
    }
    if (pendingMissingUserMessages.length > 0) {
      missingBeforeIndex.set(matchingHistoryIndex, [
        ...(missingBeforeIndex.get(matchingHistoryIndex) ?? []),
        ...pendingMissingUserMessages.splice(0),
      ]);
    }
    lastMatchedHistoryIndex = matchingHistoryIndex;
  }

  if (
    pendingMissingUserMessages.length > 0 &&
    lastMatchedHistoryIndex !== null
  ) {
    missingAfterIndex.set(lastMatchedHistoryIndex, [
      ...(missingAfterIndex.get(lastMatchedHistoryIndex) ?? []),
      ...pendingMissingUserMessages.splice(0),
    ]);
  }

  const prependedMessages = [...pendingMissingUserMessages];
  if (
    prependedMessages.length === 0 &&
    missingBeforeIndex.size === 0 &&
    missingAfterIndex.size === 0
  ) {
    return historyItems;
  }

  const merged: DurableAgUiHistoryItem[] = [...prependedMessages];
  historyItems.forEach((item, index) => {
    merged.push(...(missingBeforeIndex.get(index) ?? []), item);
    merged.push(...(missingAfterIndex.get(index) ?? []));
  });
  return merged;
}

function agUiUserMessageSignature(message: AgUiUserMessage): string {
  return agUiMessageContentText(message.content);
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const serializedEntries = entries.map(
    ([key, entryValue]) =>
      `${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
  );
  return `{${serializedEntries.join(",")}}`;
}

const NO_STRUCTURAL_DEDUPE_EVENT_TYPES = new Set<string>([
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.TOOL_CALL_ARGS,
]);

function getStringEventField(event: BaseEvent, field: string): string | null {
  const value = Reflect.get(event, field);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getIntegerEventField(event: BaseEvent, field: string): number | null {
  const value = Reflect.get(event, field);
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function getReplayDedupeKey(
  event: BaseEvent,
  identity?: ReplayIdentity,
): string | null {
  const runId = identity?.runId ?? getStringEventField(event, "runId");
  if (
    runId &&
    (event.type === EventType.RUN_STARTED ||
      event.type === EventType.RUN_FINISHED ||
      event.type === EventType.RUN_ERROR)
  ) {
    return `run-lifecycle:${runId}:${event.type}`;
  }

  const eventId = identity?.eventId ?? getStringEventField(event, "eventId");
  if (runId && eventId) {
    return `run-event:${runId}:${eventId}`;
  }
  if (eventId) {
    return `event:${eventId}`;
  }

  const idempotencyKey =
    identity?.idempotencyKey ?? getStringEventField(event, "idempotencyKey");
  if (runId && idempotencyKey) {
    return `run-idempotency:${runId}:${idempotencyKey}`;
  }
  if (idempotencyKey) {
    return `idempotency:${idempotencyKey}`;
  }

  const seq = identity?.seq ?? getIntegerEventField(event, "seq");
  if (runId && seq !== null) {
    return `run-seq:${runId}:${seq}`;
  }

  const messageId = getStringEventField(event, "messageId");
  const deltaSeq = getIntegerEventField(event, "deltaSeq");
  if (messageId && deltaSeq !== null) {
    return `message-delta:${event.type}:${messageId}:${deltaSeq}`;
  }

  if (NO_STRUCTURAL_DEDUPE_EVENT_TYPES.has(event.type)) {
    return null;
  }
  return `event:${stableSerialize(event)}`;
}

const STREAM_LOG_PREFIX = "[ag-ui][stream]";
const XREAD_ERROR_LOG_INITIAL_BUDGET = 3;
const XREAD_ERROR_LOG_EVERY_N = 20;

type StreamCloseReason =
  | "client_abort_before_start"
  | "client_abort"
  | "controller_enqueue_failed"
  | "durable_terminal_idle"
  | "durable_terminal_after_xread_error"
  | "terminal_event"
  | "replay_failed"
  | "run_not_found"
  | "malformed_replay"
  | "replay_already_terminal";

type StreamDiagnostics = {
  openedAtMs: number;
  firstFrameLatencyMs: number | null;
  replayCount: number;
  dedupeCount: number;
  xreadTimeoutCount: number;
  xreadBackoffCount: number;
  xreadErrorCount: number;
};

function isXreadTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("local redis-http command timeout") ||
    message.includes("timeout") ||
    message.includes("time out")
  );
}

function emitStreamDiagnostic(
  event: "stream_open" | "first_frame" | "stream_close",
  payload: Record<string, unknown>,
): void {
  console.info(STREAM_LOG_PREFIX, {
    event,
    ...payload,
  });
}

function isTerminalRunEventType(type: BaseEvent["type"]): boolean {
  return type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR;
}

function isAgUiBaseEvent(value: unknown): value is BaseEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return AG_UI_EVENT_TYPES.has(Reflect.get(value, "type"));
}

function readStringField(value: object, field: string): string | null {
  const candidate = Reflect.get(value, field);
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

function isValidKnownAgUiEvent(value: unknown): value is BaseEvent {
  if (!isAgUiBaseEvent(value)) {
    return false;
  }

  switch (value.type) {
    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
      return (
        readStringField(value, "threadId") !== null &&
        readStringField(value, "runId") !== null
      );
    case EventType.RUN_ERROR:
      return readStringField(value, "message") !== null;
    case EventType.TEXT_MESSAGE_START:
    case EventType.REASONING_MESSAGE_START:
      return (
        readStringField(value, "messageId") !== null &&
        readStringField(value, "role") !== null
      );
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_CHUNK:
    case EventType.REASONING_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_CHUNK:
      return (
        readStringField(value, "messageId") !== null &&
        typeof Reflect.get(value, "delta") === "string"
      );
    case EventType.TEXT_MESSAGE_END:
    case EventType.REASONING_MESSAGE_END:
      return readStringField(value, "messageId") !== null;
    case EventType.TOOL_CALL_START:
      return (
        readStringField(value, "toolCallId") !== null &&
        readStringField(value, "toolCallName") !== null
      );
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_CHUNK:
      return (
        readStringField(value, "toolCallId") !== null &&
        typeof Reflect.get(value, "delta") === "string"
      );
    case EventType.TOOL_CALL_END:
      return readStringField(value, "toolCallId") !== null;
    case EventType.TOOL_CALL_RESULT:
      return (
        readStringField(value, "toolCallId") !== null &&
        readStringField(value, "messageId") !== null &&
        Reflect.has(value, "content")
      );
    case EventType.CUSTOM:
      return (
        readStringField(value, "name") !== null && Reflect.has(value, "value")
      );
    default:
      return true;
  }
}

function readNumberField(value: object, field: string): number | null {
  const candidate = Reflect.get(value, field);
  return Number.isSafeInteger(candidate) ? candidate : null;
}

function readStringFieldOrUndefined(
  value: object,
  field: string,
): string | undefined {
  const candidate = Reflect.get(value, field);
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function parseStreamPayload(value: unknown): {
  seq: number | null;
  event: BaseEvent | null;
  identity?: ReplayIdentity;
} {
  if (isValidKnownAgUiEvent(value)) {
    return { seq: null, event: value };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { seq: null, event: null };
  }

  const seq = readNumberField(value, "seq");
  const payload = Reflect.get(value, "payload");
  if (isValidKnownAgUiEvent(payload)) {
    const projectionIndex = readNumberField(value, "projectionIndex");
    const projectionCount = readNumberField(value, "projectionCount");
    return {
      seq,
      event: payload,
      identity: {
        runId: readStringFieldOrUndefined(value, "runId"),
        eventId: readStringFieldOrUndefined(value, "eventId"),
        idempotencyKey: readStringFieldOrUndefined(value, "idempotencyKey"),
        ...(projectionIndex !== null ? { projectionIndex } : {}),
        ...(projectionCount !== null ? { projectionCount } : {}),
        ...(seq !== null ? { seq } : {}),
        ...(isAgUiTraceMetadata(Reflect.get(value, "trace"))
          ? { trace: Reflect.get(value, "trace") as AgUiTraceMetadata }
          : {}),
      },
    };
  }

  const event = Reflect.get(value, "event");
  if (isValidKnownAgUiEvent(event)) {
    return { seq, event };
  }

  return { seq, event: null };
}

function parseStreamEntries(raw: unknown): AgUiStreamEntry[] {
  // XREAD shape: [ [streamKey, [ [id, [field, value, ...]], ... ]] ] or null.
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const firstStream = raw[0];
  if (!Array.isArray(firstStream) || firstStream.length < 2) {
    return [];
  }
  const rawEntries = firstStream[1];
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const entries: AgUiStreamEntry[] = [];
  for (const entry of rawEntries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const [id, rawFields] = entry;
    if (typeof id !== "string") {
      continue;
    }
    const serialized = readEventField(rawFields);
    if (serialized == null) {
      entries.push({ id, seq: null, event: null });
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      const payload = parseStreamPayload(parsed);
      entries.push({
        id,
        seq: payload.seq,
        event: payload.event,
        ...(payload.identity ? { identity: payload.identity } : {}),
      });
    } catch (err) {
      console.warn("[ag-ui] malformed stream entry", { id, err });
      entries.push({ id, seq: null, event: null });
    }
  }
  return entries;
}

function readEventField(rawFields: unknown): string | null {
  if (!Array.isArray(rawFields)) {
    // Upstash sometimes returns an object shape already parsed.
    if (rawFields && typeof rawFields === "object") {
      const envelope = Reflect.get(rawFields, "envelope");
      if (typeof envelope === "string") {
        return envelope;
      }
      const value = Reflect.get(rawFields, "event");
      return typeof value === "string" ? value : null;
    }
    return null;
  }
  for (let i = 0; i < rawFields.length; i += 2) {
    if (rawFields[i] === "envelope" && typeof rawFields[i + 1] === "string") {
      return rawFields[i + 1] as string;
    }
  }
  for (let i = 0; i < rawFields.length; i += 2) {
    if (rawFields[i] === "event" && typeof rawFields[i + 1] === "string") {
      return rawFields[i + 1] as string;
    }
  }
  return null;
}

function encodeSseEvent(event: BaseEvent, id?: string): Uint8Array {
  const idLine = id ? `id: ${id}\n` : "";
  return ENCODER.encode(`${idLine}data: ${JSON.stringify(event)}\n\n`);
}

function isAgUiTraceMetadata(value: unknown): value is AgUiTraceMetadata {
  if (!isRecord(value)) {
    return false;
  }
  const daemonEventId = value["daemonEventId"];
  return (
    (daemonEventId === null || typeof daemonEventId === "string") &&
    typeof value["daemonEventReceivedAtMs"] === "number" &&
    Number.isFinite(value["daemonEventReceivedAtMs"])
  );
}

function toTerragonTraceSidebandValue(
  identity?: ReplayIdentity,
): TerragonTraceSidebandValue | null {
  if (!identity?.trace) {
    return null;
  }
  return {
    schemaVersion: 1,
    kind: "terragon.trace.daemon_event.received",
    ...(identity.runId ? { runId: identity.runId } : {}),
    ...(identity.eventId ? { eventId: identity.eventId } : {}),
    ...(identity.seq !== undefined ? { seq: identity.seq } : {}),
    ...(identity.projectionIndex !== undefined
      ? { projectionIndex: identity.projectionIndex }
      : {}),
    ...(identity.projectionCount !== undefined
      ? { projectionCount: identity.projectionCount }
      : {}),
    daemonEventId: identity.trace.daemonEventId,
    daemonEventReceivedAtMs: identity.trace.daemonEventReceivedAtMs,
  };
}

function buildTerragonTraceSidebandEvent(
  identity?: ReplayIdentity,
): BaseEvent | null {
  const value = toTerragonTraceSidebandValue(identity);
  if (!value) {
    return null;
  }
  return {
    type: EventType.CUSTOM,
    name: "terragon.trace.daemon_event.received",
    value,
  } as BaseEvent;
}

function encodeSseComment(comment: string): Uint8Array {
  return ENCODER.encode(`: ${comment}\n\n`);
}

function parseReplayCursor(value: string | null): ReplayCursor | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("seq:")
    ? trimmed.slice("seq:".length)
    : trimmed;
  const [seqValue, projectionIndexValue] = normalized.split(":");
  const seq = Number(seqValue);
  if (!Number.isSafeInteger(seq) || seq < -1) {
    return null;
  }
  if (projectionIndexValue === undefined) {
    return { seq, projectionIndex: null };
  }
  const projectionIndex = Number(projectionIndexValue);
  return Number.isSafeInteger(projectionIndex) && projectionIndex >= 0
    ? { seq, projectionIndex }
    : null;
}

function resolveReplayCursor(request: NextRequest): ReplayCursor | null {
  const lastEventId = parseReplayCursor(request.headers.get("last-event-id"));
  if (lastEventId !== null) {
    return lastEventId;
  }
  return parseReplayCursor(request.nextUrl.searchParams.get("fromSeq"));
}

function replayQueryAfterSeq(cursor: ReplayCursor | null): number | undefined {
  if (cursor === null) {
    return undefined;
  }
  return cursor.projectionIndex === null ? cursor.seq : cursor.seq - 1;
}

function shouldReplayEnvelope(
  entry: Pick<AgUiEventEnvelope, "seq" | "projectionIndex">,
  cursor: ReplayCursor | null,
): boolean {
  if (cursor === null) {
    return true;
  }
  if (entry.seq > cursor.seq) {
    return true;
  }
  if (entry.seq < cursor.seq || cursor.projectionIndex === null) {
    return false;
  }
  return (entry.projectionIndex ?? 0) > cursor.projectionIndex;
}

function toReplayEntries(
  envelopes: AgUiEventEnvelope[],
  cursor: ReplayCursor | null,
): ReplayEntry[] {
  return dropEventsAfterTerminalUntilNextRun(
    repairDelayedRunStartedOrdering(
      envelopes
        .filter((entry) => shouldReplayEnvelope(entry, cursor))
        .map((entry) => ({
          seq: entry.seq,
          event: entry.payload,
          identity: {
            runId: entry.runId,
            eventId: entry.eventId,
            idempotencyKey: entry.idempotencyKey,
            seq: entry.seq,
            projectionIndex: entry.projectionIndex,
            projectionCount: entry.projectionCount,
            ...(entry.trace ? { trace: entry.trace } : {}),
          },
        })),
    ),
    { keepInterRunUserAndSystemSnapshots: false },
  );
}

function getReplayEntryRunId(entry: ReplayEntry): string | null {
  return entry.identity?.runId ?? getStringEventField(entry.event, "runId");
}

function repairDelayedRunStartedOrdering(
  entries: ReplayEntry[],
): ReplayEntry[] {
  const repaired: ReplayEntry[] = [];
  let index = 0;

  while (index < entries.length) {
    const runId = getReplayEntryRunId(entries[index]!);
    if (runId === null) {
      repaired.push(entries[index]!);
      index += 1;
      continue;
    }

    const runEntries: ReplayEntry[] = [];
    while (
      index < entries.length &&
      getReplayEntryRunId(entries[index]!) === runId
    ) {
      runEntries.push(entries[index]!);
      index += 1;
    }
    repaired.push(...repairSingleRunStartedOrdering(runEntries));
  }

  return repaired;
}

function repairSingleRunStartedOrdering(entries: ReplayEntry[]): ReplayEntry[] {
  const firstRunStartedIndex = entries.findIndex(
    (entry) => entry.event.type === EventType.RUN_STARTED,
  );
  if (firstRunStartedIndex <= 0) {
    return firstRunStartedIndex === 0
      ? dropDuplicateRunStarted(entries)
      : entries;
  }

  const leadingSnapshots: ReplayEntry[] = [];
  let firstNonSnapshotIndex = 0;
  while (
    firstNonSnapshotIndex < entries.length &&
    entries[firstNonSnapshotIndex]!.event.type === EventType.MESSAGES_SNAPSHOT
  ) {
    leadingSnapshots.push(entries[firstNonSnapshotIndex]!);
    firstNonSnapshotIndex += 1;
  }

  const firstRunStarted = entries[firstRunStartedIndex]!;
  const rest = entries.filter(
    (entry, entryIndex) =>
      entryIndex >= firstNonSnapshotIndex &&
      entry.event.type !== EventType.RUN_STARTED,
  );

  return [...leadingSnapshots, firstRunStarted, ...rest];
}

function dropDuplicateRunStarted(entries: ReplayEntry[]): ReplayEntry[] {
  let hasRunStarted = false;
  return entries.filter((entry) => {
    if (entry.event.type !== EventType.RUN_STARTED) {
      return true;
    }
    if (hasRunStarted) {
      return false;
    }
    hasRunStarted = true;
    return true;
  });
}

function toReplayEntriesWithoutTerminalFilter(
  envelopes: AgUiEventEnvelope[],
  cursor: ReplayCursor | null,
): ReplayEntry[] {
  return repairDelayedRunStartedOrdering(
    envelopes
      .filter((entry) => shouldReplayEnvelope(entry, cursor))
      .map((entry) => ({
        seq: entry.seq,
        event: entry.payload,
        identity: {
          runId: entry.runId,
          eventId: entry.eventId,
          idempotencyKey: entry.idempotencyKey,
          seq: entry.seq,
          projectionIndex: entry.projectionIndex,
          projectionCount: entry.projectionCount,
          ...(entry.trace ? { trace: entry.trace } : {}),
        },
      })),
  );
}

function dropEventsAfterTerminalUntilNextRun(
  entries: ReplayEntry[],
  options: { keepInterRunUserAndSystemSnapshots: boolean } = {
    keepInterRunUserAndSystemSnapshots: false,
  },
): ReplayEntry[] {
  const filtered: ReplayEntry[] = [];
  let sawTerminal = false;

  for (const entry of entries) {
    if (entry.event.type === EventType.RUN_STARTED) {
      sawTerminal = false;
      filtered.push(entry);
      continue;
    }
    if (sawTerminal) {
      if (
        options.keepInterRunUserAndSystemSnapshots &&
        isUserOrSystemMessagesSnapshot(entry.event)
      ) {
        filtered.push(entry);
      }
      continue;
    }
    filtered.push(entry);
    if (isTerminalRunEventType(entry.event.type)) {
      sawTerminal = true;
    }
  }

  return filtered;
}

function isUserOrSystemMessagesSnapshot(event: BaseEvent): boolean {
  if (event.type !== EventType.MESSAGES_SNAPSHOT) {
    return false;
  }
  const { messages } = event as MessagesSnapshotEvent;
  return (
    messages.length > 0 &&
    messages.every(
      (message) => message.role === "user" || message.role === "system",
    )
  );
}

function splitHistoryOnlyPrefix(envelopes: AgUiEventEnvelope[]): {
  historyOnlyLastSeq: number | null;
  replayEnvelopes: AgUiEventEnvelope[];
} {
  const firstRunEventIndex = envelopes.findIndex(
    (entry) => entry.payload.type !== EventType.MESSAGES_SNAPSHOT,
  );
  if (firstRunEventIndex <= 0) {
    return { historyOnlyLastSeq: null, replayEnvelopes: envelopes };
  }
  const lastHistoryOnlyEnvelope = envelopes[firstRunEventIndex - 1];
  return {
    historyOnlyLastSeq: lastHistoryOnlyEnvelope?.seq ?? null,
    replayEnvelopes: envelopes.slice(firstRunEventIndex),
  };
}

function sseIdForReplayEntry(
  seq: number | null,
  identity?: ReplayIdentity,
): string | undefined {
  if (seq === null) {
    return undefined;
  }
  if (identity?.projectionCount !== undefined && identity.projectionCount > 1) {
    return `${seq}:${identity.projectionIndex ?? 0}`;
  }
  return String(seq);
}

function buildResumeRunStartedEvent({
  threadId,
  runId,
}: {
  threadId: string;
  runId: string;
}): BaseEvent {
  return {
    type: EventType.RUN_STARTED,
    threadId,
    runId,
  };
}

/**
 * Capture the stream's current last ID BEFORE the DB replay query so that
 * events XADD'd while the replay is in flight are not dropped by the live
 * tail's `$` cursor. Empty/missing streams fall back to `"0"` so the first
 * XREAD picks up any entry published after this moment.
 */
async function captureStreamCursor(streamKey: string): Promise<string> {
  try {
    const latest = await redis.xrevrange(streamKey, "+", "-", 1);
    if (latest && typeof latest === "object") {
      const ids = Object.keys(latest);
      if (ids.length > 0 && typeof ids[0] === "string") {
        return ids[0]!;
      }
    }
    return "0";
  } catch (err) {
    console.warn("[ag-ui] captureStreamCursor failed; falling back to 0", {
      streamKey,
      err,
    });
    return "0";
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> },
) {
  const session = await getSessionOrNull();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { threadId } = await context.params;
  const threadChatId = request.nextUrl.searchParams.get("threadChatId");
  const runIdParam = request.nextUrl.searchParams.get("runId");
  const replayCursor = resolveReplayCursor(request);
  const replayCursorSeq = replayCursor?.seq ?? null;
  const shouldFrameRunAgentResume = request.method === "POST";

  if (!threadChatId) {
    return NextResponse.json(
      { error: "Missing threadChatId" },
      { status: 400 },
    );
  }

  // Verify BOTH that the thread belongs to the session user AND that the
  // threadChatId belongs to that same thread. Without the join a caller
  // who owns thread-A could pass threadChatId pointing at someone else's
  // chat. Return 404 on mismatch to avoid leaking existence.
  const ownership = await db
    .select({
      id: schema.threadChat.id,
      messages: schema.threadChat.messages,
    })
    .from(schema.threadChat)
    .innerJoin(schema.thread, eq(schema.threadChat.threadId, schema.thread.id))
    .where(
      and(
        eq(schema.threadChat.id, threadChatId),
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, session.user.id),
      ),
    )
    .limit(1);

  if (ownership.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (request.nextUrl.searchParams.get("history") === "messages") {
    const envelopes = await getAgUiEventEnvelopesForThreadChat({
      db,
      threadChatId,
    });
    const historyEntries = dropEventsAfterTerminalUntilNextRun(
      toReplayEntriesWithoutTerminalFilter(envelopes, null),
      { keepInterRunUserAndSystemSnapshots: true },
    );
    const historyEvents = historyEntries.map((entry) => entry.event);
    const history = getDurableAgUiHistoryItemsFromEvents(historyEvents);
    const messages = mergeMissingDbUserMessagesIntoHistory({
      historyItems: history.items,
      dbMessages: ownership[0]?.messages ?? [],
    });
    const includedCursor =
      history.lastSeqOffset >= 0
        ? historyEntries[history.lastSeqOffset]?.seq
        : undefined;
    return NextResponse.json({
      messages,
      lastSeq: includedCursor ?? -1,
    });
  }

  const streamKey = agUiStreamKey(threadChatId);

  // Capture the live-tail cursor BEFORE the DB replay so in-flight events
  // published during the replay query window are not lost. This preserves
  // the at-least-once contract: client will receive all events for the run
  // (via DB replay) plus any new stream entries from this cursor onward.
  // Some duplicates are acceptable — AG-UI is designed to de-dupe by event
  // identity on the client.
  const initialLastId = await captureStreamCursor(streamKey);

  // Resolve the effective runId:
  //  - If the client supplied `?runId=X`, use it verbatim (reconnect path).
  //  - If the client supplied only a seq cursor, replay from that cursor
  //    thread-chat-wide. This is the history-adapter resume path; binding it
  //    to a guessed latest run can strand terminal events for delayed-start
  //    runs behind an unrelated older run.
  //  - Otherwise the connect is fresh; default to the thread chat's latest
  //    run. Clients that land on an empty thread chat (no runs yet) get a
  //    live-tailing stream with no history — the first RUN_STARTED written by
  //    a new daemon-event will naturally be the first event on the wire.
  let resolvedRunId: string | null = runIdParam;
  if (resolvedRunId === null && replayCursorSeq === null) {
    try {
      resolvedRunId = await getLatestRunIdForThreadChat({
        db,
        threadChatId,
      });
    } catch (error) {
      console.error(
        "[ag-ui] getLatestRunIdForThreadChat failed; defaulting to live-tail",
        { threadId, threadChatId },
        error,
      );
      resolvedRunId = null;
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const diagnostics: StreamDiagnostics = {
        openedAtMs: Date.now(),
        firstFrameLatencyMs: null,
        replayCount: 0,
        dedupeCount: 0,
        xreadTimeoutCount: 0,
        xreadBackoffCount: 0,
        xreadErrorCount: 0,
      };
      let closed = false;
      let closeReason: StreamCloseReason | null = null;
      let keepaliveTimer: NodeJS.Timeout | null = null;

      const close = (reason: StreamCloseReason) => {
        if (closed) return;
        closed = true;
        closeReason = reason;
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
        emitStreamDiagnostic("stream_close", {
          threadId,
          threadChatId,
          runId: resolvedRunId,
          closeReason,
          firstFrameLatencyMs: diagnostics.firstFrameLatencyMs,
          replayCount: diagnostics.replayCount,
          dedupeCount: diagnostics.dedupeCount,
          xreadTimeoutCount: diagnostics.xreadTimeoutCount,
          xreadBackoffCount: diagnostics.xreadBackoffCount,
          xreadErrorCount: diagnostics.xreadErrorCount,
        });
        recordAgentTraceSpan({
          traceId: resolvedRunId,
          name: "server.agui.sse.closed",
          startedAtMs: diagnostics.openedAtMs,
          endedAtMs: Date.now(),
          attributes: {
            threadId,
            threadChatId,
            closeReason,
            replayCount: diagnostics.replayCount,
            dedupeCount: diagnostics.dedupeCount,
            xreadTimeoutCount: diagnostics.xreadTimeoutCount,
            xreadBackoffCount: diagnostics.xreadBackoffCount,
            xreadErrorCount: diagnostics.xreadErrorCount,
          },
        });
      };

      const markFirstFrameIfNeeded = () => {
        if (diagnostics.firstFrameLatencyMs !== null) {
          return;
        }
        diagnostics.firstFrameLatencyMs = Date.now() - diagnostics.openedAtMs;
        emitStreamDiagnostic("first_frame", {
          threadId,
          threadChatId,
          runId: resolvedRunId,
          firstFrameLatencyMs: diagnostics.firstFrameLatencyMs,
        });
        recordAgentTraceSpan({
          traceId: resolvedRunId,
          name: "server.agui.sse.first_frame",
          startedAtMs: diagnostics.openedAtMs,
          endedAtMs: Date.now(),
          attributes: {
            threadId,
            threadChatId,
            firstFrameLatencyMs: diagnostics.firstFrameLatencyMs,
          },
        });
      };

      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          markFirstFrameIfNeeded();
          controller.enqueue(chunk);
        } catch {
          close("controller_enqueue_failed");
        }
      };

      emitStreamDiagnostic("stream_open", {
        threadId,
        threadChatId,
        runId: resolvedRunId,
        hasRunIdParam: runIdParam !== null,
        replayCursorSeq,
      });
      recordAgentTraceSpan({
        traceId: resolvedRunId,
        name: "server.agui.sse.opened",
        startedAtMs: diagnostics.openedAtMs,
        endedAtMs: diagnostics.openedAtMs,
        attributes: {
          threadId,
          threadChatId,
          hasRunIdParam: runIdParam !== null,
          replayCursorSeq,
        },
      });

      // Tear down on client abort. `once: true` handles listener cleanup.
      const abortSignal = request.signal;
      if (abortSignal.aborted) {
        close("client_abort_before_start");
        return;
      }
      abortSignal.addEventListener("abort", () => close("client_abort"), {
        once: true,
      });
      const replayedEventDedupeKeys = new Set<string>();
      let lastDeliveredSeq = replayCursorSeq;
      let hasEmittedAgUiDataEvent = false;
      let activeEmittedRunId: string | null = null;
      // Snapshot-first framing contract: always emit a baseline marker before
      // replay or live-tail frames so clients can align first-paint lifecycle.
      enqueue(encodeSseComment(BASELINE_SNAPSHOT_COMMENT));

      const rememberReplayedEventDedupeKeys = (
        event: BaseEvent,
        identity?: ReplayIdentity,
      ) => {
        const dedupeKey = getReplayDedupeKey(event, identity);
        if (dedupeKey !== null) {
          replayedEventDedupeKeys.add(dedupeKey);
        }
        if (identity !== undefined) {
          const structuralDedupeKey = getReplayDedupeKey(event);
          if (structuralDedupeKey !== null) {
            replayedEventDedupeKeys.add(structuralDedupeKey);
          }
        }
      };

      const consumeReplayedEventDedupeKey = (
        event: BaseEvent,
        identity?: ReplayIdentity,
      ): boolean => {
        const dedupeKey = getReplayDedupeKey(event, identity);
        if (dedupeKey !== null && replayedEventDedupeKeys.has(dedupeKey)) {
          replayedEventDedupeKeys.delete(dedupeKey);
          return true;
        }
        if (identity !== undefined) {
          const structuralDedupeKey = getReplayDedupeKey(event);
          if (
            structuralDedupeKey !== null &&
            replayedEventDedupeKeys.has(structuralDedupeKey)
          ) {
            replayedEventDedupeKeys.delete(structuralDedupeKey);
            return true;
          }
        }
        return false;
      };

      const ensurePostResumeStartsWithRun = (
        event: BaseEvent,
        identity?: ReplayIdentity,
      ): boolean => {
        if (
          !shouldFrameRunAgentResume ||
          hasEmittedAgUiDataEvent ||
          event.type === EventType.RUN_STARTED ||
          event.type === EventType.RUN_ERROR
        ) {
          return true;
        }

        const resumeRunId =
          resolvedRunId ??
          identity?.runId ??
          getStringEventField(event, "runId");
        if (resumeRunId === null) {
          console.error(
            "[ag-ui] cursored resume cannot infer run id before first live event",
            {
              threadId,
              threadChatId,
              firstType: event.type,
            },
          );
          const errorEvent = mapRunErrorToAgui(
            `Thread chat ${threadChatId} resume log is malformed: first event has no run id`,
            "replay_failed",
          );
          hasEmittedAgUiDataEvent = true;
          enqueue(encodeSseEvent(errorEvent));
          close("malformed_replay");
          return false;
        }

        resolvedRunId = resumeRunId;
        const runStartedEvent = buildResumeRunStartedEvent({
          threadId,
          runId: resumeRunId,
        });
        rememberReplayedEventDedupeKeys(runStartedEvent);
        hasEmittedAgUiDataEvent = true;
        activeEmittedRunId = resumeRunId;
        enqueue(encodeSseEvent(runStartedEvent));
        return true;
      };

      const emitAgUiEvent = (
        event: BaseEvent,
        seq: number | null,
        identity?: ReplayIdentity,
      ): boolean => {
        if (!ensurePostResumeStartsWithRun(event, identity)) {
          return false;
        }
        if (event.type === EventType.RUN_STARTED) {
          const nextRunId = getStringEventField(event, "runId");
          if (
            activeEmittedRunId !== null &&
            nextRunId !== null &&
            activeEmittedRunId !== nextRunId
          ) {
            enqueue(
              encodeSseEvent({
                type: EventType.RUN_FINISHED,
                threadId,
                runId: activeEmittedRunId,
              }),
            );
          }
          activeEmittedRunId = nextRunId;
          resolvedRunId = nextRunId;
        }
        hasEmittedAgUiDataEvent = true;
        const traceEvent = buildTerragonTraceSidebandEvent(identity);
        if (traceEvent && event.type !== EventType.RUN_STARTED) {
          enqueue(encodeSseEvent(traceEvent));
        }
        enqueue(encodeSseEvent(event, sseIdForReplayEntry(seq, identity)));
        if (isTerminalRunEventType(event.type)) {
          const terminalRunId = getStringEventField(event, "runId");
          if (terminalRunId === null || terminalRunId === activeEmittedRunId) {
            activeEmittedRunId = null;
          }
        }
        return true;
      };

      const emitReplayEntry = (entry: ReplayEntry): boolean => {
        if (!isValidKnownAgUiEvent(entry.event)) {
          console.error("[ag-ui] threadChat replay: malformed AG-UI event", {
            threadId,
            threadChatId,
            runId: resolvedRunId,
            eventType: Reflect.get(entry.event, "type"),
            seq: entry.seq,
          });
          const errorEvent = mapRunErrorToAgui(
            `Run ${resolvedRunId} log contains malformed AG-UI event at seq ${entry.seq ?? "unknown"}`,
            "replay_failed",
          );
          emitAgUiEvent(errorEvent, null);
          close("malformed_replay");
          return false;
        }

        diagnostics.replayCount += 1;
        rememberReplayedEventDedupeKeys(entry.event, entry.identity);
        if (entry.seq !== null) {
          lastDeliveredSeq =
            lastDeliveredSeq === null
              ? entry.seq
              : Math.max(lastDeliveredSeq, entry.seq);
        }
        return emitAgUiEvent(entry.event, entry.seq, entry.identity);
      };

      const frameResumeReplayEntries = (
        replayEntries: ReplayEntry[],
      ): boolean => {
        if (
          replayCursorSeq === null ||
          !shouldFrameRunAgentResume ||
          replayEntries.length === 0
        ) {
          return true;
        }

        while (replayEntries[0]?.event.type === EventType.MESSAGES_SNAPSHOT) {
          const [entry] = replayEntries.splice(0, 1);
          if (entry?.seq !== null && entry?.seq !== undefined) {
            lastDeliveredSeq =
              lastDeliveredSeq === null
                ? entry.seq
                : Math.max(lastDeliveredSeq, entry.seq);
          }
        }

        if (
          replayEntries.length === 0 ||
          replayEntries[0]?.event.type === EventType.RUN_STARTED
        ) {
          return true;
        }

        const resumeRunId =
          resolvedRunId ??
          (replayEntries[0] ? getReplayEntryRunId(replayEntries[0]) : null);
        if (resumeRunId === null) {
          console.error(
            "[ag-ui] cursored resume cannot infer run id for synthetic RUN_STARTED",
            {
              threadId,
              threadChatId,
              firstType: replayEntries[0]?.event.type,
            },
          );
          const errorEvent = mapRunErrorToAgui(
            `Thread chat ${threadChatId} resume log is malformed: first event has no run id`,
            "replay_failed",
          );
          enqueue(encodeSseEvent(errorEvent));
          close("malformed_replay");
          return false;
        }

        resolvedRunId = resumeRunId;
        replayEntries.unshift({
          seq: null,
          event: buildResumeRunStartedEvent({
            threadId,
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
                threadId,
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
      };

      const replayDurableEventsAfterCursor = async (): Promise<boolean> => {
        let replayEnvelopes: AgUiEventEnvelope[];
        try {
          replayEnvelopes = await getAgUiEventEnvelopesForThreadChat({
            db,
            threadChatId,
            afterSeq: lastDeliveredSeq ?? undefined,
          });
        } catch (error) {
          console.warn(
            "[ag-ui] durable catch-up replay failed during live-tail; continuing",
            { threadId, threadChatId, runId: resolvedRunId },
            error,
          );
          return false;
        }

        if (replayEnvelopes.length === 0) {
          return false;
        }

        const replayEntries = toReplayEntries(replayEnvelopes, null);
        if (!frameResumeReplayEntries(replayEntries)) {
          return true;
        }
        let emittedReplayEntry = false;
        for (const entry of replayEntries) {
          if (!emitReplayEntry(entry)) {
            return true;
          }
          emittedReplayEntry = true;
          if (isTerminalRunEventType(entry.event.type)) {
            close("terminal_event");
            return true;
          }
        }
        return emittedReplayEntry;
      };

      // Shared live-tail helper: block-polls Redis starting from the cursor
      // captured before the DB replay. Used after both the run-replay path
      // (for active runs still in progress) and the no-history path (for
      // empty thread chats awaiting their first RUN_STARTED).
      const liveTail = async (params?: { runId?: string; userId?: string }) => {
        let liveTailParams = params;
        const localRedisHttpMode = isLocalRedisHttpMode();
        keepaliveTimer = setInterval(() => {
          enqueue(encodeSseComment("keepalive"));
        }, KEEPALIVE_INTERVAL_MS);

        const maybeEmitTerminalFromDurable = async (
          phase: "idle" | "xread_error",
          cause?: unknown,
        ): Promise<boolean> => {
          if (!liveTailParams?.runId || !liveTailParams.userId) {
            return false;
          }
          try {
            const runContext = await getAgentRunContextByRunId({
              db,
              runId: liveTailParams.runId,
              userId: liveTailParams.userId,
            });
            if (
              runContext !== null &&
              isTerminalAgentRunStatus(runContext.status)
            ) {
              const replayedDurableEvents =
                await replayDurableEventsAfterCursor();
              if (replayedDurableEvents) {
                return true;
              }
              const terminalEvent = buildRunTerminalAgUi({
                threadId,
                runId: liveTailParams.runId,
                daemonRunStatus: runContext.status,
                errorMessage: runContext.failureTerminalReason ?? null,
                errorCode: runContext.failureCategory ?? null,
              });
              if (!emitAgUiEvent(terminalEvent, null)) {
                return true;
              }
              close(
                phase === "idle"
                  ? "durable_terminal_idle"
                  : "durable_terminal_after_xread_error",
              );
              return true;
            }
          } catch (error) {
            console.warn(
              "[ag-ui] durable run status check failed during live-tail; continuing",
              { phase, threadId, threadChatId, runId: liveTailParams.runId },
              cause ?? error,
            );
          }
          return false;
        };

        const maybeDiscoverRunFromDurableLog = async (): Promise<boolean> => {
          if (liveTailParams?.runId) {
            return false;
          }
          let latestRunId: string | null = null;
          try {
            latestRunId = await getLatestRunIdForThreadChat({
              db,
              threadChatId,
            });
          } catch (error) {
            console.warn(
              "[ag-ui] latest-run discovery failed during empty live-tail; continuing",
              { threadId, threadChatId },
              error,
            );
            return false;
          }
          if (latestRunId === null) {
            return false;
          }

          resolvedRunId = latestRunId;
          const replayed = await replayDurableEventsAfterCursor();
          if (!closed) {
            liveTailParams = {
              runId: latestRunId,
              userId: session.user.id,
            };
          }
          return replayed;
        };

        let lastId = initialLastId;
        let consecutiveEmpty = 0;
        let emptyPollsSinceTerminalCheck = 0;
        while (!closed) {
          const adaptiveBlockMS = Math.min(
            MAX_XREAD_BLOCK_MS,
            MIN_XREAD_BLOCK_MS * (1 + consecutiveEmpty),
          );
          // Local redis-http transport has a tighter command-timeout budget than
          // production Upstash, so keep xread block windows short in dev to
          // avoid deterministic timeout/backoff loops.
          const blockMS = localRedisHttpMode
            ? MIN_XREAD_BLOCK_MS
            : adaptiveBlockMS;
          try {
            const raw = await redis.xread(streamKey, lastId, {
              count: XREAD_COUNT,
              blockMS,
            });
            if (closed) break;
            const entries = parseStreamEntries(raw);
            if (entries.length === 0) {
              consecutiveEmpty++;
              emptyPollsSinceTerminalCheck++;
              if (
                emptyPollsSinceTerminalCheck >=
                TERMINAL_STATUS_CHECK_EVERY_EMPTY_POLLS
              ) {
                emptyPollsSinceTerminalCheck = 0;
                if (!liveTailParams?.runId) {
                  await maybeDiscoverRunFromDurableLog();
                } else if (liveTailParams.userId) {
                  if (await maybeEmitTerminalFromDurable("idle")) {
                    break;
                  }
                }
              }
            } else {
              consecutiveEmpty = 0;
              emptyPollsSinceTerminalCheck = 0;
              for (const entry of entries) {
                lastId = entry.id;
                if (entry.event != null) {
                  if (
                    entry.seq !== null &&
                    !shouldReplayEnvelope(
                      {
                        seq: entry.seq,
                        projectionIndex: entry.identity?.projectionIndex,
                      },
                      replayCursor,
                    )
                  ) {
                    diagnostics.dedupeCount += 1;
                    continue;
                  }
                  // Replay and live-tail intentionally overlap during connect so
                  // we do not drop events written mid-replay. Skip the first
                  // matching live event if it was already emitted from replay.
                  if (
                    consumeReplayedEventDedupeKey(entry.event, entry.identity)
                  ) {
                    diagnostics.dedupeCount += 1;
                    continue;
                  }
                  if (entry.seq !== null) {
                    lastDeliveredSeq =
                      lastDeliveredSeq === null
                        ? entry.seq
                        : Math.max(lastDeliveredSeq, entry.seq);
                  }
                  if (!emitAgUiEvent(entry.event, entry.seq, entry.identity)) {
                    return;
                  }
                  if (isTerminalRunEventType(entry.event.type)) {
                    close("terminal_event");
                    return;
                  }
                }
              }
            }
          } catch (error) {
            if (closed) break;
            // Reset adaptive growth on transport failures so the next read
            // re-enters with the smallest block window.
            consecutiveEmpty = 0;
            diagnostics.xreadErrorCount += 1;
            diagnostics.xreadBackoffCount += 1;
            if (isXreadTimeoutError(error)) {
              diagnostics.xreadTimeoutCount += 1;
            }
            const shouldLogXreadError =
              diagnostics.xreadErrorCount <= XREAD_ERROR_LOG_INITIAL_BUDGET ||
              diagnostics.xreadErrorCount % XREAD_ERROR_LOG_EVERY_N === 0;
            if (shouldLogXreadError) {
              console.warn(
                "[ag-ui] XREAD failed, backing off",
                {
                  streamKey,
                  xreadErrorCount: diagnostics.xreadErrorCount,
                  xreadTimeoutCount: diagnostics.xreadTimeoutCount,
                  xreadBackoffCount: diagnostics.xreadBackoffCount,
                },
                error,
              );
            }
            emptyPollsSinceTerminalCheck++;
            if (
              emptyPollsSinceTerminalCheck >=
              TERMINAL_STATUS_CHECK_EVERY_EMPTY_POLLS
            ) {
              emptyPollsSinceTerminalCheck = 0;
              if (!liveTailParams?.runId) {
                await maybeDiscoverRunFromDurableLog();
              } else if (liveTailParams.userId) {
                if (await maybeEmitTerminalFromDurable("xread_error", error)) {
                  break;
                }
              }
            }
            await new Promise((resolve) =>
              setTimeout(resolve, XREAD_BACKOFF_MS),
            );
          }
        }
      };

      // -----------------------------------------------------------------
      // Path A: fresh connect against a thread chat with no runs yet.
      // Send an immediate keepalive comment so proxies don't close idle
      // connections before the first real event lands, then live-tail.
      // -----------------------------------------------------------------
      if (resolvedRunId === null) {
        const replayed =
          replayCursorSeq !== null
            ? await replayDurableEventsAfterCursor()
            : false;
        if (closed) {
          return;
        }
        if (!replayed) {
          enqueue(encodeSseComment("awaiting-first-run"));
        }
        await liveTail(
          resolvedRunId !== null
            ? { runId: resolvedRunId, userId: session.user.id }
            : undefined,
        );
        return;
      }

      // -----------------------------------------------------------------
      // Path B: replay the thread chat's full AG-UI event log, then
      // live-tail if the latest/explicit run is still active. Replay is
      // threadChat-scoped so reconnects can hydrate prior runs without
      // going back through the DB-message transcript path.
      // -----------------------------------------------------------------
      let replayEnvelopes: AgUiEventEnvelope[];
      try {
        replayEnvelopes =
          resolvedRunId !== null && replayCursorSeq === null
            ? await getAgUiEventEnvelopesForRun({
                db,
                runId: resolvedRunId,
                threadChatId,
              })
            : await getAgUiEventEnvelopesForThreadChat({
                db,
                threadChatId,
                afterSeq: replayQueryAfterSeq(replayCursor),
              });
      } catch (error) {
        console.error(
          "[ag-ui] threadChat replay failed",
          { threadId, threadChatId, runId: resolvedRunId },
          error,
        );
        const errorEvent = mapRunErrorToAgui(
          error instanceof Error ? error.message : "Replay failed",
          "replay_failed",
        );
        enqueue(encodeSseEvent(errorEvent));
        close("replay_failed");
        return;
      }

      let terminalRunContext: Awaited<
        ReturnType<typeof getAgentRunContextByRunId>
      > = null;
      if (resolvedRunId !== null) {
        try {
          terminalRunContext = await getAgentRunContextByRunId({
            db,
            runId: resolvedRunId,
            userId: session.user.id,
          });
        } catch (error) {
          console.warn(
            "[ag-ui] run context lookup failed; continuing without durable terminal fallback",
            {
              threadId,
              threadChatId,
              runId: resolvedRunId,
            },
            error,
          );
        }
      }

      if (replayEnvelopes.length === 0) {
        if (
          replayCursorSeq !== null &&
          resolvedRunId !== null &&
          terminalRunContext !== null &&
          !isTerminalAgentRunStatus(terminalRunContext.status)
        ) {
          if (shouldFrameRunAgentResume) {
            const runStartedEvent = buildResumeRunStartedEvent({
              threadId,
              runId: resolvedRunId,
            });
            rememberReplayedEventDedupeKeys(runStartedEvent);
            emitAgUiEvent(runStartedEvent, null);
          }
          await liveTail({ runId: resolvedRunId, userId: session.user.id });
          return;
        }
        if (
          replayCursorSeq !== null &&
          terminalRunContext !== null &&
          isTerminalAgentRunStatus(terminalRunContext.status)
        ) {
          close("replay_already_terminal");
          return;
        }
        const errorEvent = mapRunErrorToAgui(
          `Thread chat ${threadChatId} has no AG-UI events after cursor ${replayCursorSeq ?? "start"}`,
          "run_not_found",
        );
        enqueue(encodeSseEvent(errorEvent));
        close("run_not_found");
        return;
      }

      const resolvedRunHasTerminalEvent =
        resolvedRunId === null
          ? false
          : replayEnvelopes.some(
              (entry) =>
                entry.runId === resolvedRunId &&
                isTerminalRunEventType(entry.payload.type),
            );

      let syntheticTerminalEntry: ReplayEntry | null = null;
      if (
        !resolvedRunHasTerminalEvent &&
        terminalRunContext !== null &&
        isTerminalAgentRunStatus(terminalRunContext.status)
      ) {
        const terminalEvent = buildRunTerminalAgUi({
          threadId,
          runId: resolvedRunId,
          daemonRunStatus: terminalRunContext.status,
          errorMessage: terminalRunContext.failureTerminalReason ?? null,
          errorCode: terminalRunContext.failureCategory ?? null,
        });
        syntheticTerminalEntry = { seq: null, event: terminalEvent };
      }

      const historyPrefix =
        replayCursorSeq === null
          ? splitHistoryOnlyPrefix(replayEnvelopes)
          : { historyOnlyLastSeq: null, replayEnvelopes };
      const streamReplayEnvelopes = historyPrefix.replayEnvelopes;
      if (historyPrefix.historyOnlyLastSeq !== null) {
        lastDeliveredSeq =
          lastDeliveredSeq === null
            ? historyPrefix.historyOnlyLastSeq
            : Math.max(lastDeliveredSeq, historyPrefix.historyOnlyLastSeq);
      }

      if (replayCursorSeq === null && streamReplayEnvelopes.length === 0) {
        enqueue(encodeSseComment("awaiting-first-run"));
        await liveTail();
        return;
      }

      const replayEntries = toReplayEntries(
        streamReplayEnvelopes,
        replayCursor,
      );

      if (replayCursorSeq === null) {
        // Contract: a complete thread-chat replay MUST start with
        // RUN_STARTED after any history-only message snapshots. Cursored
        // reconnects may legitimately start in the middle of a run.
        if (replayEntries[0]?.event.type !== EventType.RUN_STARTED) {
          console.error(
            "[ag-ui] threadChat replay: first event was not RUN_STARTED",
            {
              threadId,
              threadChatId,
              runId: resolvedRunId,
              firstType: replayEntries[0]?.event.type,
            },
          );
          const errorEvent = mapRunErrorToAgui(
            `Thread chat ${threadChatId} log is malformed: first event is ${replayEntries[0]?.event.type ?? "empty"}, expected RUN_STARTED`,
            "replay_failed",
          );
          enqueue(encodeSseEvent(errorEvent));
          close("malformed_replay");
          return;
        }
      }

      if (
        replayCursorSeq !== null &&
        !frameResumeReplayEntries(replayEntries)
      ) {
        return;
      }
      if (syntheticTerminalEntry !== null) {
        replayEntries.push(syntheticTerminalEntry);
      }

      const isRunComplete =
        resolvedRunHasTerminalEvent || syntheticTerminalEntry !== null;

      for (const entry of replayEntries) {
        if (!emitReplayEntry(entry)) {
          return;
        }
      }

      if (isRunComplete) {
        // The run already terminated before connect. Close the stream so
        // the client's SSE consumer knows the server has nothing more to
        // say. Live-tail here would block on an XREAD poll forever
        // without producing useful output.
        close("replay_already_terminal");
        return;
      }

      await liveTail({ runId: resolvedRunId, userId: session.user.id });
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// POST: client-initiated runs.
// HttpAgent POSTs RunAgentInput; we extract the new user message + metadata,
// call followUp() via runFollowUpFromAgUiInput, then fall through to the SSE
// stream machinery shared with GET. The advisory lock in the adapter holds
// the dedup invariant (see ADR docs/plans/2026-04-30-runtime-owns-writes-adr.md).
//
// Replay mode (header X-Terragon-Test-Replay): adapter skips, request streams
// as today. Preserves integration-harness fixture validity.
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ threadId: string }> },
): Promise<Response> {
  // 1. Resolve threadId from params
  const { threadId } = await ctx.params;

  // 2. Authenticate — same path as GET
  const session = await getSessionOrNull();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // 3. Resolve threadChatId from URL query param
  const threadChatId = request.nextUrl.searchParams.get("threadChatId");
  if (!threadChatId) {
    return NextResponse.json(
      { error: "Missing threadChatId" },
      { status: 400 },
    );
  }

  // 4. Detect replay mode via header X-Terragon-Test-Replay (any truthy value)
  const isReplayMode = !!request.headers.get("X-Terragon-Test-Replay");

  // 5. Parse the request body as RunAgentInput (skip in replay mode)
  if (!isReplayMode) {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      // Body parse failure — no body or non-JSON; fall through to SSE stream
      rawBody = null;
    }

    const parsed =
      rawBody != null
        ? RunAgentInputSchema.safeParse(rawBody)
        : { success: false as const };

    // 6. If body parsed successfully, call the adapter for new appends.
    // Active history resumes use AG-UI POST only to open the SSE stream; they
    // must not replay the last user message back into the follow-up queue.
    if (parsed.success) {
      const traceId =
        getTraceIdFromAgUiForwardedProps(parsed.data.forwardedProps) ??
        parsed.data.runId;
      recordAgentTraceSpan({
        traceId,
        name: "server.agui.post.received",
        attributes: {
          threadId,
          threadChatId,
          runId: parsed.data.runId,
        },
      });
      const intent = readTerragonPostIntent(parsed.data.forwardedProps);
      if (intent === "append") {
        const followUpStartedAtMs = Date.now();
        const result = await runFollowUpFromAgUiInput({
          threadId,
          threadChatId,
          userId,
          body: parsed.data,
          isReplayMode: false,
        });
        const resultKind =
          "error" in result
            ? result.error.kind
            : "runId" in result
              ? "dispatched"
              : result.skipped;
        recordAgentTraceSpan({
          traceId,
          name: "server.agui.followup.dispatched",
          startedAtMs: followUpStartedAtMs,
          endedAtMs: Date.now(),
          attributes: {
            threadId,
            threadChatId,
            runId: "runId" in result ? result.runId : parsed.data.runId,
            result: resultKind,
          },
        });

        if ("error" in result) {
          const { error } = result;
          if (error.kind === "unauthorized") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
          }
          if (error.kind === "thread-not-found") {
            return NextResponse.json(
              { error: "Thread not found" },
              { status: 404 },
            );
          }
          if (error.kind === "lock-held") {
            return NextResponse.json(
              { error: "Run already in progress" },
              { status: 409 },
            );
          }
          if (error.kind === "invalid-input") {
            return NextResponse.json({ error: error.reason }, { status: 400 });
          }
        }
        // { runId } or { skipped } — fall through to SSE stream
      }
    }
    // Body absent or parse failed — fall through to SSE stream (back-compat)
  }

  // 7. Fall through: open the SSE stream via the existing GET handler
  return GET(request, ctx);
}

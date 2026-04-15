// Unified drop-site telemetry for unknown protocol events.
//
// Every transport (Codex app-server, ACP, Claude SDK) has an implicit
// fallthrough branch that returns null / drops the event when the server
// emits something the daemon doesn't recognize. Historically these drops were
// completely silent, which made protocol drift invisible — e.g. Codex's
// `collabAgentToolCall` was dropped for weeks before anyone noticed.
//
// This module funnels every drop through one recording point so operators
// can answer: "what events are we ignoring, and how often?" The API is
// intentionally minimal (side-effect only) so wiring it into the 3 transport
// handlers is a one-line change per drop site.
//
// Future work (Wave 1b): POST the ring buffer to /api/daemon-unknown-event
// on a heartbeat, persist to delivery_raw_event_log, and surface via the
// operator firehose UI.

export type UnknownEventTransport = "codex" | "acp" | "claude-sdk";

export interface UnknownEventContext {
  transport: UnknownEventTransport;
  /** JSON-RPC method, sessionUpdate type, or SDK message type that we didn't recognize. */
  method: string;
  /** Sub-discriminant when `method` is a wrapper (e.g. `item/started` → itemType). */
  itemType?: string;
  threadChatId?: string;
  /** Free-form reason, e.g. "no handler in METHOD_TO_THREAD_EVENT_TYPE". */
  reason?: string;
  /** Truncated raw payload for later forensics. Large objects are summarized. */
  payload?: unknown;
}

export interface StoredUnknownEvent extends UnknownEventContext {
  timestamp: string;
  key: string;
}

const MAX_BUFFER_SIZE = 500;
const MAX_PAYLOAD_CHARS = 2000;
const WARN_LOG_INTERVAL_MS = 60_000;

const counters = new Map<string, number>();
const ringBuffer: StoredUnknownEvent[] = [];
const lastWarnAt = new Map<string, number>();

function redactPayload(payload: unknown): unknown {
  if (payload === undefined || payload === null) return payload;
  try {
    const serialized = JSON.stringify(payload);
    if (serialized.length <= MAX_PAYLOAD_CHARS) {
      return JSON.parse(serialized);
    }
    return {
      __truncated: true,
      preview: serialized.slice(0, MAX_PAYLOAD_CHARS),
      originalLength: serialized.length,
    };
  } catch {
    return { __unserializable: true, typeof: typeof payload };
  }
}

function keyFor(ctx: UnknownEventContext): string {
  return `${ctx.transport}:${ctx.method}${ctx.itemType ? `:${ctx.itemType}` : ""}`;
}

/**
 * Record a drop-site hit. Called from the default / fallthrough branch of each
 * transport handler. Never throws — telemetry must never break the main loop.
 */
export function recordUnknownEvent(ctx: UnknownEventContext): void {
  try {
    const key = keyFor(ctx);
    const nextCount = (counters.get(key) ?? 0) + 1;
    counters.set(key, nextCount);

    const stored: StoredUnknownEvent = {
      ...ctx,
      payload: redactPayload(ctx.payload),
      timestamp: new Date().toISOString(),
      key,
    };
    ringBuffer.push(stored);
    if (ringBuffer.length > MAX_BUFFER_SIZE) {
      ringBuffer.shift();
    }

    // Rate-limited warning: log the first occurrence immediately, then at most
    // once per minute per key. Prevents log spam from high-frequency drops but
    // ensures operators see new drop kinds the moment they appear.
    const now = Date.now();
    const last = lastWarnAt.get(key) ?? 0;
    if (now - last >= WARN_LOG_INTERVAL_MS) {
      lastWarnAt.set(key, now);
      // Writing directly to stderr avoids coupling to any specific Logger
      // instance (daemon files each construct their own). Callers that need
      // structured logs can read getRecentUnknownEvents() on a heartbeat.
      process.stderr.write(
        `[unknown-event] ${key} count=${nextCount}` +
          (ctx.reason ? ` reason="${ctx.reason}"` : "") +
          (ctx.threadChatId ? ` thread=${ctx.threadChatId}` : "") +
          "\n",
      );
    }
  } catch {
    // Telemetry must never break the main loop.
  }
}

export function getUnknownEventCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function getRecentUnknownEvents(limit = 100): StoredUnknownEvent[] {
  if (limit >= ringBuffer.length) return [...ringBuffer];
  return ringBuffer.slice(ringBuffer.length - limit);
}

/** Test-only: clear all counters + buffer. */
export function __resetUnknownEventTelemetry(): void {
  counters.clear();
  ringBuffer.length = 0;
  lastWarnAt.clear();
}

// Unified drop-site telemetry for unknown protocol events.
//
// Every transport (Codex app-server, ACP, Claude SDK) has an implicit
// fallthrough branch that returns null / drops the event when the server
// emits something the daemon doesn't recognize. Historically these drops were
// completely silent, which made protocol drift invisible — e.g. Codex's
// `collabAgentToolCall` was dropped for weeks before anyone noticed.
//
// This module funnels every drop through one recording point so operators
// can answer: "what events are we ignoring, and how often?"
//
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
}

const WARN_LOG_INTERVAL_MS = 60_000;

const counters = new Map<string, number>();
const lastWarnAt = new Map<string, number>();

function keyFor(ctx: UnknownEventContext): string {
  return `${ctx.transport}:${ctx.method}${ctx.itemType ? `:${ctx.itemType}` : ""}`;
}

/**
 * Record a drop-site hit. Called from the default / fallthrough branch of each
 * transport handler. Never throws; telemetry must never break the main run.
 */
export function recordUnknownEvent(ctx: UnknownEventContext): void {
  try {
    const key = keyFor(ctx);
    const nextCount = (counters.get(key) ?? 0) + 1;
    counters.set(key, nextCount);

    // Rate-limited warning: log the first occurrence immediately, then at most
    // once per minute per key. Prevents log spam from high-frequency drops but
    // ensures operators see new drop kinds the moment they appear.
    const now = Date.now();
    const last = lastWarnAt.get(key) ?? 0;
    if (now - last >= WARN_LOG_INTERVAL_MS) {
      lastWarnAt.set(key, now);
      // Writing directly to stderr avoids coupling to any specific Logger
      // instance (daemon files each construct their own).
      process.stderr.write(
        `[unknown-event] ${key} count=${nextCount}` +
          (ctx.reason ? ` reason="${ctx.reason}"` : "") +
          (ctx.threadChatId ? ` thread=${ctx.threadChatId}` : "") +
          "\n",
      );
    }
  } catch {
    // Telemetry must never break the main run.
  }
}

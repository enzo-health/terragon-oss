import type { BaseEvent } from "@ag-ui/core";
import { redis } from "@/lib/redis";

const ENCODER = new TextEncoder();

export const STREAM_LOG_PREFIX = "[ag-ui][stream]";

export type StreamCloseReason =
  | "client_abort"
  | "client_abort_before_start"
  | "controller_enqueue_failed"
  | "replay_failed"
  | "run_not_found"
  | "malformed_replay"
  | "replay_already_terminal"
  | "terminal_event"
  | "durable_terminal_idle"
  | "durable_terminal_after_xread_error";

export type StreamDiagnostics = {
  openedAtMs: number;
  firstFrameLatencyMs: number | null;
  replayCount: number;
  dedupeCount: number;
  xreadTimeoutCount: number;
  xreadBackoffCount: number;
  xreadErrorCount: number;
};

export function encodeSseEvent(event: BaseEvent, id?: string): Uint8Array {
  const idLine = id ? `id: ${id}\n` : "";
  return ENCODER.encode(`${idLine}data: ${JSON.stringify(event)}\n\n`);
}

export function encodeSseComment(comment: string): Uint8Array {
  return ENCODER.encode(`: ${comment}\n\n`);
}

export function emitStreamDiagnostic(
  event: "stream_open" | "first_frame" | "stream_close",
  payload: Record<string, unknown>,
): void {
  console.info(STREAM_LOG_PREFIX, {
    event,
    ...payload,
  });
}

export function isXreadTimeoutError(error: unknown): boolean {
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

/**
 * Capture the stream's current last ID BEFORE the DB replay query so that
 * events XADD'd while the replay is in flight are not dropped by the live
 * tail's `$` cursor. Empty/missing streams fall back to `"0"` so the first
 * XREAD picks up any entry published after this moment.
 */
export async function captureStreamCursor(streamKey: string): Promise<string> {
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

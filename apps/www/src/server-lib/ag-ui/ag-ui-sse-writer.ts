import type { BaseEvent } from "@ag-ui/core";

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

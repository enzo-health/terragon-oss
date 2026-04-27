# AG-UI Stream Observability Note

This rollout adds bounded, structured stream diagnostics in `apps/www/src/app/api/ag-ui/[threadId]/route.ts`.

## Emitted Diagnostics

- `stream_open`
  - `threadId`, `threadChatId`, `runId`, `hasRunIdParam`
- `first_frame`
  - `firstFrameLatencyMs` from stream start to first SSE frame enqueue
- `stream_close`
  - `closeReason`
  - `firstFrameLatencyMs`
  - `replayCount`
  - `dedupeCount` (replay/live overlap skips)
  - `xreadTimeoutCount`
  - `xreadBackoffCount`
  - `xreadErrorCount`

## Log Boundedness

- Per stream, diagnostics are bounded to:
  - one `stream_open`
  - one `first_frame` (at most)
  - one `stream_close`
- `XREAD` error warnings are throttled:
  - first 3 errors
  - then every 20th error

## Rollout Checklist

1. Deploy and validate `stream_open` / `first_frame` / `stream_close` events appear for active AG-UI threads.
2. Confirm `firstFrameLatencyMs` is populated for normal replay and fresh empty-thread connects.
3. Verify local redis-http stress shows rising `xreadTimeoutCount`/`xreadBackoffCount` with bounded warning volume.
4. Confirm `closeReason` distribution matches expectations (aborts, terminal events, replay-terminal closes).

# Autoresearch: Daemon-to-Client Streaming Performance

## Objective

Optimize the latency and throughput of streaming events from the daemon (running in sandboxes) to the frontend client. The daemon buffers and flushes messages via HTTP POST to `/api/daemon-event`, which then publishes to clients via WebSocket broadcast.

**Key Flow:**

1. Agent generates message (stdout parse)
2. Daemon buffers in `messageBuffer`/`deltaBuffer`/`metaEventBuffer`
3. Timer-based flush (default 33ms) or immediate flush on certain events
4. HTTP POST to `/api/daemon-event` with envelope v2 + canonical events
5. API persists to DB + publishes to broadcast channel
6. Client receives via PartySocket WebSocket

## Metrics

- **Primary**: `median_e2e_latency_ms` (lower is better) - End-to-end latency from daemon message generation to client receipt
- **Secondary**:
  - `p99_e2e_latency_ms` - Tail latency
  - `messages_per_second` - Throughput capacity
  - `flush_count` - Number of HTTP POSTs (lower = more batching = better)
  - `daemon_buffer_ms` - Time messages spend in daemon buffer
  - `api_processing_ms` - API route processing time

## How to Run

`./autoresearch.sh` - Runs the streaming benchmark test

The benchmark:

1. Starts Docker services (PostgreSQL, Redis) if not running
2. Runs a simulated daemon streaming test via vitest
3. Measures latency at each stage of the pipeline
4. Outputs `METRIC median_e2e_latency_ms=X`

## Files in Scope

| File                                                | Purpose                                    |
| --------------------------------------------------- | ------------------------------------------ |
| `packages/daemon/src/daemon.ts`                     | Core daemon with buffering and flush logic |
| `packages/daemon/src/runtime.ts`                    | Runtime interface for HTTP POST operations |
| `apps/www/src/app/api/daemon-event/route.ts`        | API route receiving daemon events          |
| `apps/www/src/server-lib/handle-daemon-event.ts`    | Event processing and DB persistence        |
| `packages/shared/src/broadcast/broadcast-server.ts` | WebSocket broadcast publishing             |

## Off Limits

- **DO NOT** change the envelope v2 protocol or canonical event schema (breaking changes)
- **DO NOT** modify the database schema
- **DO NOT** change authentication/authorization logic
- **DO NOT** break backward compatibility with existing daemon versions

## Constraints

- All tests must pass (`pnpm test`)
- TypeScript must compile without errors
- No new runtime dependencies
- Changes must work with both Docker and E2B sandboxes
- Must maintain backward compatibility with existing daemon deployments

## What's Been Tried

### Baseline (Established)

- Default `messageFlushDelay = 33ms` (~30fps)
- Delta/meta flush uses 16ms (60fps)
- Codex item.completed coalesces at 250ms
- Individual message buffer per threadChatId

### Hypotheses to Test

1. **Adaptive Flush Delay**: Reduce `messageFlushDelay` to 16ms during high-velocity streaming, increase to 50ms during idle
2. **Velocity-Based Batching**: Flush immediately if buffer grows >N messages, otherwise use timer
3. **Delta Coalescing**: Batch deltas within a 8ms window before flushing to reduce HTTP overhead
4. **HTTP Keep-Alive**: Ensure connection reuse for daemon-event POSTs
5. **Compression**: Enable gzip compression for large payloads
6. **Buffer Size Limits**: Cap max buffer size to prevent memory bloat on high-volume streams

## Experiment Log

<!-- Log entries will be added here by the experiment loop -->

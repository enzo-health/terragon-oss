# Autoresearch: Daemon-to-Client Streaming Optimization

## Objective

Optimize the daemon-to-client streaming architecture to achieve "buttery smooth" real-time sync with minimal perceived latency. The current system has buffering delays up to 1000ms and lacks visibility into end-to-end latency.

## Current Architecture

```
Agent Process → Daemon Buffer → POST /api/daemon-event → DB Write → PartyKit Broadcast → Client
                    ↓
              Delta Buffer (ephemeral, 50ms flush)
```

### Key Bottlenecks Identified

1. **Message Flush Delay**: 1000ms default, 250ms for codex item.completed
2. **No Backpressure Handling**: Daemon doesn't adapt to slow server responses
3. **No E2E Latency Measurement**: Can't see where delays accumulate
4. **Delta vs Message Buffer Mismatch**: Deltas (50ms) and messages (1000ms) flush independently
5. **No Client Sync Protocol**: Client can't detect gaps or request catch-up
6. **Envelope Ack Wait**: Server POST waits for ack before next flush

## Metrics

- **Primary**: `e2e_latency_p50` (ms, lower is better) - End-to-end message latency from daemon generation to client receipt
- **Secondary**:
  - `daemon_flush_ms` - Time for daemon to flush buffer
  - `server_process_ms` - Server processing time
  - `broadcast_ms` - PartyKit broadcast latency
  - `events_per_second` - Throughput metric
  - `dropped_events` - Count of failed deliveries

## How to Run

```bash
./autoresearch.sh
```

Outputs `METRIC name=value` lines for each phase.

## Files in Scope

### Core Streaming

- `packages/daemon/src/daemon.ts` - Message/delta buffering and flush logic
- `packages/daemon/src/runtime.ts` - HTTP POST implementation
- `packages/shared/src/broadcast-server.ts` - PartyKit publishing

### Server Handling

- `apps/www/src/app/api/daemon-event/route.ts` - POST handler, envelope ack
- `apps/www/src/server-lib/handle-daemon-event.ts` - Event processing
- `apps/www/src/server-lib/ag-ui-publisher.ts` - AG-UI event persistence + broadcast

### Optional (Advanced)

- `apps/broadcast/src/server.ts` - PartyKit WebSocket server
- `apps/www/src/components/chat/` - Client-side receipt (measurement only)

## Off Limits

- Agent process spawning (claude.ts, codex.ts, etc.) - out of scope
- Message parsing logic - we optimize transport, not content
- Database schema changes - use existing tables
- PartyKit protocol changes - work within existing broadcast API

## Constraints

- Tests must pass: `pnpm -C packages/daemon test`
- No new npm dependencies without approval
- Must maintain backward compatibility with existing envelope protocol
- Client must continue to work without changes (measure-only on client)

## Optimization Hypotheses

### Phase 1: Immediate Wins (Low Risk)

1. **Adaptive Flush Delay**: Reduce default from 1000ms to 100ms, keep 250ms burst debounce
2. **Delta-Only Priority**: Fast-path delta flushing even when message buffer is empty
3. **Envelope Ack Overlap**: Start next flush timer immediately after POST starts, not after ack

### Phase 2: Backpressure & Flow Control (Medium Risk)

4. **Response-Time Adaptive Buffer**: If server responds slowly (>500ms), temporarily increase flush delay
5. **Delta Batching**: Batch deltas within 16ms window (1 frame) for efficiency without perceptible delay
6. **Server-Side Prioritization**: Process deltas before messages in daemon-event handler

### Phase 3: Sync Protocol (Higher Risk, Needs Care)

7. **Seq-Based Sync**: Add seq to broadcast so client can detect gaps
8. **Client Catch-Up**: Endpoint for client to request missed events by seq range
9. **Heartbeat Ping**: Regular ping with latest seq for sync verification

## What's Been Tried

### Baseline (Commit: TBD)

- Default flush: 1000ms
- Codex flush: 250ms on item.completed
- Delta flush: 50ms when triggered by enqueueDelta
- Message processing: Sequential, waits for envelope ack

### Hypothesis 1: Reduce default flush delay to 100ms

**Status**: Not tried yet
**Expected**: ~5x latency improvement for non-codex agents
**Risk**: More frequent small POSTs, higher server load

### Hypothesis 2: Delta priority queue

**Status**: Not tried yet
**Expected**: Deltas stream smoothly even when messages batch
**Risk**: None, deltas are already ephemeral

### Hypothesis 3: Overlapping flush windows

**Status**: Not tried yet
**Expected**: Better throughput under load
**Risk**: Reordering if acks arrive out of sequence

## Measurement Strategy

We need programmatic measurement of the full pipeline. Since we can't modify client code easily, we'll:

1. **Instrument daemon**: Add timestamps at each phase (generate, enqueue, flush-start, post-start, post-end)
2. **Instrument server**: Add timestamps at receipt, process-start, process-end, broadcast-start, broadcast-end
3. **Simulate client**: Use Redis pub/sub or SSE to measure receipt time
4. **Synthetic load**: Generate events at realistic rates (10-100 events/sec)

The benchmark script will:

- Start daemon runtime in test mode
- Inject synthetic messages
- Measure timestamps through full pipeline
- Output aggregated metrics

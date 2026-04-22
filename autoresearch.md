# Autoresearch: Sub-100ms Latency Challenge

## Objective

Achieve sub-100ms end-to-end latency (currently 233ms). Need to find and eliminate the remaining 133ms+ of overhead.

## Current State (233ms)

```
Estimated breakdown:
- Daemon flush: 33ms (known)
- HTTP POST + Server processing: ~150ms (estimated, NEEDS MEASUREMENT)
- DB write: ~30ms (estimated, NEEDS MEASUREMENT)
- PartyKit broadcast: ~50ms (estimated, NEEDS MEASUREMENT)
- Total: ~233ms
```

## Target State (<100ms)

```
Aggressive target:
- Daemon flush: 16ms (reduce from 33ms)
- HTTP POST overhead: <20ms (keep connection alive/pooled)
- Server processing: <30ms (optimize hot path)
- DB write: <20ms (batch, async where possible)
- Broadcast: <14ms (or async fire-and-forget)
- Total: <100ms
```

## Hypotheses for <100ms

### H1: Ultra-aggressive flush (16ms messages, 8ms deltas)

Risk: High HTTP overhead, CPU thrashing
Expected gain: 17ms (233→216)

### H2: Connection pooling / keep-alive

Risk: None - should always help
Expected gain: 30-50ms (eliminates TCP handshake)

### H3: Async DB writes (fire-and-forget)

Risk: Data loss on crash, eventual consistency issues
Expected gain: 20-30ms

### H4: Async broadcast (don't wait for PartyKit)

Risk: Message loss if server crashes immediately after
Expected gain: 40-50ms

### H5: Server-side batching (accept multiple events per POST)

Risk: Complex, requires protocol changes
Expected gain: 20-40ms (amortized overhead)

### H6: In-memory only path (skip DB for streaming)

Risk: Data loss, no persistence
Expected gain: 30-50ms

## Measurement Strategy

First, we MUST measure actual component latency:

1. Instrument daemon serverPost with precise timing
2. Add server-side timing breakdown (receive→process→db→broadcast)
3. Add client-side timing (broadcast→render)
4. Use real timing, not estimates

## What's Been Tried

### Phase 1: Baseline

- 1000ms flush → 1200ms E2E

### Phase 2: Optimized (Current Best)

- 33ms flush + 16ms deltas → 233ms E2E
- 5.1x improvement achieved
- 425 tests passing

### Phase 3: Sub-100ms (IN PROGRESS)

- Need to break down the 150ms server/processing time
- Need to measure, not estimate

## Constraints

- Must maintain 425 test pass rate
- No protocol changes without backward compatibility
- No data loss acceptable for production
- Must be measurable and reproducible

## New Metric: Component Breakdown

We need granular metrics:

- `daemon_flush_wait_ms` - Time from enqueue to flush start
- `daemon_post_send_ms` - HTTP POST send time
- `daemon_post_wait_ms` - HTTP response wait time
- `server_receive_ms` - Time to receive and parse POST
- `server_db_write_ms` - Time for DB writes
- `server_broadcast_ms` - Time for PartyKit broadcast
- `client_receive_ms` - Time from broadcast to client receipt

Total = sum of all components

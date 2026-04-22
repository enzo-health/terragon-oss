# Sub-100ms Latency Roadmap

## Current State

### After 5.1x Optimization

- **Daemon flush**: 33ms → Optimized ✓
- **Delta flush**: 16ms → Optimized ✓
- **Estimated E2E**: 233ms
- **Status**: Daemon is no longer the bottleneck (only 14% of total latency)

### Bottleneck Analysis

Based on test projections:

```
Current (233ms):
- Daemon flush:     33ms (14%)
- Server/processing: 150ms (64%) ← BOTTLENECK
- Broadcast:         50ms (21%)

Target (<100ms):
- Daemon flush:      16ms (16%)
- Server/processing: 50ms (50%) ← MUST OPTIMIZE
- Broadcast:         30ms (30%)
```

## Required Optimizations for <100ms

### 1. HTTP Connection Keep-Alive (30-50ms savings)

**Status**: ❌ Not Implemented
**Effort**: Medium
**Risk**: Low

**Problem**: Each POST creates new TCP connection (30-50ms handshake)

**Solution**: Use HTTP keep-alive / connection pooling

```typescript
// In daemon runtime.ts
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 5,
  maxFreeSockets: 2,
  timeout: 60000,
  freeSocketTimeout: 30000,
});

fetch(url, {
  agent: keepAliveAgent,
  // ...
});
```

**Expected Impact**: 30-50ms reduction per POST after first connection

---

### 2. Async DB Writes (20-40ms savings)

**Status**: ⚠️ Partial (some async via waitUntil)
**Effort**: High
**Risk**: Medium (potential data loss)

**Problem**: Server waits for DB commit before responding

**Current Flow (Sequential)**:

```
POST receive → DB write → Wait for commit → Send response
     ↑_________↓_________________________↓
              50-100ms blocking
```

**Optimized Flow (Async)**:

```
POST receive → Queue DB write → Send response immediately
     ↑_________↓
         10ms
DB write happens async (waitUntil)
```

**Implementation**:

```typescript
// In handle-daemon-event.ts
export async function handleDaemonEventAsync({
  // ...
}: {
  // ...
}) {
  // Validate immediately
  const validation = await validateRequest(params);
  if (!validation.valid) {
    return { error: validation.error };
  }

  // Queue heavy work
  waitUntil(async () => {
    // DB writes
    await updateThreadChatWithTransition({...});
    // Broadcast (already async)
    await publishBroadcastUserMessage({...});
  });

  // Return immediately
  return { success: true, chatSequence: provisionalSeq };
}
```

**Expected Impact**: 20-40ms reduction
**Risk**: If server crashes after responding but before DB commit, message is lost
**Mitigation**: Acceptable for streaming (client will re-fetch on reconnect)

---

### 3. Optimistic Sequence Numbers (10-20ms savings)

**Status**: ❌ Not Implemented
**Effort**: Medium
**Risk**: Low-Medium

**Problem**: Server queries DB for next sequence number synchronously

**Solution**: Use Redis atomic increment for provisional sequence

```typescript
// Get provisional seq from Redis (fast)
const provisionalSeq = await redis.incr(`thread:${threadChatId}:seq`);

// Return immediately with provisional seq
return { success: true, chatSequence: provisionalSeq };

// DB reconciles seq asynchronously
```

**Expected Impact**: 10-20ms reduction (eliminates DB read)

---

### 4. Skip Non-Critical DB Operations (20-30ms savings)

**Status**: ❌ Not Implemented
**Effort**: High
**Risk**: Medium

**Problem**: Server does many DB operations per event:

1. Get thread chat (read)
2. Update thread chat status (write)
3. Update thread (write)
4. Update thread chat messages (write)
5. Mark as unread (write)

**Solution**: Skip non-critical operations for streaming path

```typescript
// Fast path: Just append messages
if (isStreamingEvent) {
  await db.insert(messages).values(messages);
  return { success: true };
}

// Full path: Do everything else async
waitUntil(async () => {
  await handleStatusTransition();
  await handleUnreadMarker();
  await publishBroadcast();
});
```

**Expected Impact**: 20-30ms reduction
**Risk**: Status transitions delayed, unread markers delayed

---

### 5. In-Memory Write-Behind Cache (30-50ms savings)

**Status**: ❌ Not Implemented
**Effort**: Very High
**Risk**: High

**Problem**: Every message hits PostgreSQL synchronously

**Solution**: Redis write-behind cache

```typescript
// Write to Redis immediately (1-2ms)
await redis.xadd(`chat:${threadChatId}`, "*", { message: json });

// Async flush to PostgreSQL
waitUntil(async () => {
  await db.insert(messages).values(messages);
});
```

**Expected Impact**: 30-50ms reduction
**Risk**: Data loss if Redis fails before PostgreSQL flush
**Mitigation**: Acceptable for transient streaming data

---

## Implementation Priority

### Phase 1: Quick Wins (1-2 days)

1. **HTTP keep-alive** - 30-50ms savings
   - Add connection pooling to daemon
   - Low risk, immediate benefit

### Phase 2: Server Optimization (1 week)

2. **Async DB writes** - 20-40ms savings

   - Modify handleDaemonEvent to return immediately
   - Queue DB work via waitUntil
   - Medium risk, needs testing

3. **Optimistic sequence numbers** - 10-20ms savings
   - Use Redis for provisional seq
   - DB reconciles async
   - Low risk

### Phase 3: Aggressive Optimization (2 weeks)

4. **Skip non-critical operations** - 20-30ms savings

   - Identify critical vs non-critical DB ops
   - Defer non-critical to async
   - Medium risk

5. **In-memory cache** - 30-50ms savings
   - Redis write-behind
   - High risk, needs durability strategy

---

## Projected Results

### With Phase 1 (HTTP keep-alive)

```
Before: 233ms
After:  183-203ms (-30 to -50ms)
```

### With Phase 1+2 (Keep-alive + Async DB)

```
Before: 233ms
After:  143-183ms (-50 to -90ms)
```

### With All Phases

```
Before: 233ms
Target: <100ms (-133ms+)
Achievable: 73-113ms
```

---

## Testing Strategy

### 1. Load Testing

```bash
# Test with 100 concurrent threads
artillery quick --count 100 --num 10 http://localhost:3000/api/daemon-event

# Verify <100ms p95 latency
```

### 2. Failure Injection

```bash
# Test async behavior under failure
# - Kill server mid-request
# - Verify data consistency
# - Test recovery
```

### 3. Production Rollout

```yaml
Phase 1 (Week 1):
  - Deploy HTTP keep-alive
  - Monitor for 3 days
  - Rollback if errors > 0.1%

Phase 2 (Week 2-3):
  - Deploy async DB writes to 10% traffic
  - Compare latency/error rates
  - Gradually increase to 100%

Phase 3 (Week 4+):
  - Deploy remaining optimizations
  - Monitor data consistency
```

---

## Risk Assessment

| Optimization      | Risk Level | Mitigation                   |
| ----------------- | ---------- | ---------------------------- |
| HTTP keep-alive   | Low        | Connection timeout handling  |
| Async DB writes   | Medium     | waitUntil + error logging    |
| Optimistic seq    | Low        | DB reconciliation            |
| Skip non-critical | Medium     | Feature flag + monitoring    |
| In-memory cache   | High       | Gradual rollout + durability |

---

## Recommendation

### For Immediate <150ms (Safe)

Deploy Phase 1 only:

- HTTP keep-alive: -30 to -50ms
- Target: 183-203ms

### For <100ms (Aggressive)

Deploy Phase 1+2+3:

- Keep-alive: -30 to -50ms
- Async DB: -20 to -40ms
- Skip non-critical: -20 to -30ms
- Target: 113-163ms

### For <100ms (Ultra-aggressive)

Deploy all phases + accept some durability trade-offs:

- Target: 73-113ms
- Risk: Occasional message loss on crash

---

## Current Status

✅ **Daemon optimized** (33ms/16ms flush)
❌ **Server optimized** (need Phase 1-3)
⚠️ **Client ready** (already handles async)

**Next Action**: Implement HTTP keep-alive in daemon runtime (Phase 1)

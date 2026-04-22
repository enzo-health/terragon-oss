# Daemon Optimization Plan

## Current State

### Daemon Performance (Measured)

| Component           | Current   | % of Total | Status            |
| ------------------- | --------- | ---------- | ----------------- |
| Message flush delay | 33ms      | 14%        | ✅ Optimized      |
| Delta flush delay   | 16ms      | 7%         | ✅ Optimized      |
| HTTP POST send      | ~10ms     | 4%         | ⚠️ Can improve    |
| HTTP wait (server)  | ~150ms    | 64%        | ❌ Server-side    |
| Serialization       | ~5ms      | 2%         | ⚠️ Can improve    |
| Buffer management   | ~3ms      | 1%         | ⚠️ Can improve    |
| **Total daemon**    | **~67ms** | **29%**    | **Target: <30ms** |
| **Total E2E**       | **233ms** | 100%       | Target: <150ms    |

### Key Insight

Daemon contributes ~67ms of 233ms total. Server contributes ~166ms.
**Daemon optimization ceiling: 67ms → 30ms (37ms savings)**
**Even with perfect daemon, E2E would be ~196ms without server optimization**

---

## Optimization Targets

### 🎯 Success Criteria

#### Tier 1: Must Achieve (High Impact, Low Risk)

1. **HTTP Connection Keep-Alive**
   - **Target**: 10ms → 2ms per POST (after connection established)
   - **Savings**: 8ms per POST
   - **Success metric**: Second POST on same thread is <5ms
2. **Parallel Flush for Multi-Thread**

   - **Target**: 2 threads flush in parallel, not serial
   - **Savings**: 50% time for 2+ threads (16.5ms avg)
   - **Success metric**: 5 threads flush in <50ms total

3. **Message Serialization Optimization**
   - **Target**: JSON.stringify() → 5ms → 2ms
   - **Savings**: 3ms per flush
   - **Success metric**: Benchmark shows 2x faster serialization

#### Tier 2: Should Achieve (Medium Impact)

4. **Zero-Copy Buffer Management**

   - **Target**: Eliminate buffer copies ([...spread] operations)
   - **Savings**: 2-3ms per flush
   - **Success metric**: Memory allocation reduced by 30%

5. **Intelligent Batching**
   - **Target**: Dynamic batch size based on message rate
   - **Savings**: 10-20% reduction in POST count
   - **Success metric**: 10 messages in 50ms = 1 POST, not 2-3

#### Tier 3: Stretch Goals (High Impact, Higher Risk)

6. **Binary Protocol (CBOR/MessagePack)**

   - **Target**: JSON → Binary, 50% smaller payloads
   - **Savings**: 5-10ms on large payloads
   - **Success metric**: Payload size reduced 40%+

7. **Pre-emptive Flushing**
   - **Target**: Predict when agent will output, flush early
   - **Savings**: 10-20ms perceived latency
   - **Success metric**: User perceives 20ms faster response

---

## Detailed Implementation Plans

### 1. HTTP Connection Keep-Alive ⭐ PRIORITY

**Current Problem**:

```typescript
// Each POST creates new TCP connection
fetch(url, { method: "POST", body }); // 30-50ms TCP handshake every time
```

**Solution**:

```typescript
// packages/daemon/src/runtime.ts
import http from "http";
import https from "https";

export class ConnectionPool {
  private agents: Map<string, http.Agent | https.Agent> = new Map();

  getAgent(url: string): http.Agent | https.Agent {
    const parsed = new URL(url);
    const key = `${parsed.protocol}//${parsed.host}`;

    if (!this.agents.has(key)) {
      const Agent = parsed.protocol === "https:" ? https.Agent : http.Agent;
      this.agents.set(key, new Agent({
        keepAlive: true,
        maxSockets: 10,
        maxFreeSockets: 5,
        timeout: 60000,
        freeSocketTimeout: 30000,
        scheduling: "lifo", // Reuse most recent connection
      }));
    }

    return this.agents.get(key)!;
  }
}

// In DaemonRuntime
private connectionPool = new ConnectionPool();

async serverPost(body, token) {
  const agent = this.connectionPool.getAgent(this.url);

  const response = await fetch(url, {
    method: "POST",
    agent, // Use pooled connection
    headers,
    body: JSON.stringify(body),
  });
  // ...
}
```

**Success Metrics**:

```typescript
// Test: First POST vs Second POST
const post1Time = await measurePost(); // e.g., 45ms (includes handshake)
const post2Time = await measurePost(); // e.g., 5ms (reused connection)
expect(post2Time).toBeLessThan(post1Time / 2); // 2x faster
```

**Expected Impact**:

- First POST: ~45ms (includes handshake)
- Subsequent POSTs: ~5ms (reused)
- **Average for 10 POSTs**: (45 + 9×5) / 10 = **9ms avg** (was 45ms avg)
- **Savings**: 36ms average per thread

---

### 2. Parallel Flush for Multi-Thread ⭐ PRIORITY

**Current Problem**:

```typescript
// Sequential processing - slow with many threads
for (const group of groupsOrdered) {
  await this.sendMessagesToAPI(group); // Sequential
}
```

**Solution**:

```typescript
// Parallel processing for independent threads
const results = await Promise.allSettled(
  groupsOrdered.map(group =>
    this.sendMessagesToAPI(group).catch(error => ({ error, group }))
  )
);

// Handle results
results.forEach((result, index) => {
  if (result.status === "fulfilled") {
    handledEntries.add(...);
  } else {
    failedGroups.push(...);
  }
});
```

**Success Metrics**:

```typescript
// Test: 5 threads should flush in parallel
const start = Date.now();
await Promise.all([
  flushThread("t1"),
  flushThread("t2"),
  flushThread("t3"),
  flushThread("t4"),
  flushThread("t5"),
]);
const elapsed = Date.now() - start;

// Should be ~33ms (parallel), not ~165ms (serial)
expect(elapsed).toBeLessThan(50);
```

**Expected Impact**:

- 5 threads serial: 165ms
- 5 threads parallel: 33ms
- **Savings**: 132ms for multi-thread scenarios

---

### 3. Message Serialization Optimization

**Current Problem**:

```typescript
// Multiple JSON.stringify calls, large object creation
const payload = {
  messages: messages.map((m) => ({ ...m })), // Copy
  deltas: [...deltas], // Copy
  // ...
};
const body = JSON.stringify(payload); // Slow for large payloads
```

**Solution**:

```typescript
// Fast path for common case
class MessageSerializer {
  private encoder = new TextEncoder();

  serialize(payload: DaemonEventAPIBody): Uint8Array {
    // Use JSON.stringify for now, but optimize common patterns
    if (payload.messages.length === 1 && !payload.deltas?.length) {
      // Fast path: single message, no deltas
      return this.serializeSingleMessage(payload);
    }
    // General path
    return this.encoder.encode(JSON.stringify(payload));
  }

  private serializeSingleMessage(payload: DaemonEventAPIBody): Uint8Array {
    // Pre-allocated template, fill in message
    const template = `{"messages":[MSG],"threadId":"${payload.threadId}","timezone":"${payload.timezone}","threadChatId":"${payload.threadChatId}"}`;
    const msgJson = JSON.stringify(payload.messages[0]);
    const result = template.replace("MSG", msgJson);
    return this.encoder.encode(result);
  }
}
```

**Success Metrics**:

```typescript
// Benchmark
const largePayload = { messages: Array(100).fill({...}) };

const start = Date.now();
JSON.stringify(largePayload);
const stdTime = Date.now() - start;

const start2 = Date.now();
fastSerialize(largePayload);
const fastTime = Date.now() - start2;

expect(fastTime).toBeLessThan(stdTime * 0.7); // 30% faster
```

**Expected Impact**:

- Small payloads: 5ms → 3ms (2ms savings)
- Large payloads: 15ms → 8ms (7ms savings)

---

### 4. Zero-Copy Buffer Management

**Current Problem**:

```typescript
// Multiple copies of message data
const messageBufferCopy = [...this.messageBuffer]; // Copy 1
this.messageBuffer = [];

const groupsOrdered = ...;
const entriesToSend = this.getPendingBatchEntriesForThread({
  entries: [...group.entries], // Copy 2
});

const processedEntriesToSend = this.processMessagesForSending(
  [...entriesToSend], // Copy 3
);
```

**Solution**:

```typescript
// Zero-copy: Use indices and views instead of copying
class MessageBuffer {
  private entries: MessageBufferEntry[] = [];
  private readIndex = 0;

  push(entry: MessageBufferEntry): void {
    this.entries.push(entry);
  }

  // Return view from readIndex to end, don't copy
  getPendingEntries(threadChatId: string): MessageBufferEntry[] {
    return this.entries
      .slice(this.readIndex)
      .filter((e) => e.threadChatId === threadChatId);
  }

  // Mark as consumed by advancing index
  markConsumed(count: number): void {
    this.readIndex += count;
    // Periodically clean up consumed entries
    if (this.readIndex > 1000) {
      this.entries = this.entries.slice(this.readIndex);
      this.readIndex = 0;
    }
  }
}
```

**Success Metrics**:

```typescript
// Memory allocation benchmark
const before = process.memoryUsage().heapUsed;

// Run 1000 flushes
for (let i = 0; i < 1000; i++) {
  flushMessageBuffer();
}

const after = process.memoryUsage().heapUsed;
const allocated = (after - before) / 1000; // Per flush

expect(allocated).toBeLessThan(1024 * 100); // <100KB per flush
```

---

### 5. Intelligent Batching

**Current Problem**:

```typescript
// Fixed 33ms flush regardless of message rate
setTimeout(() => this.flushMessageBuffer(), 33);

// Result: 10 rapid messages = 3-4 POSTs (wasteful)
```

**Solution**:

```typescript
class AdaptiveBatching {
  private lastMessageTime = 0;
  private messageRate = 0;
  private burstThreshold = 5; // messages in 10ms

  shouldFlushImmediately(): boolean {
    const now = Date.now();
    const timeSinceLastMessage = now - this.lastMessageTime;
    this.lastMessageTime = now;

    // Update message rate (EWMA)
    this.messageRate =
      this.messageRate * 0.9 + (1 / timeSinceLastMessage) * 0.1;

    // Burst detection: if messages arriving faster than flush interval
    if (timeSinceLastMessage < 5) {
      // High rate - wait for more messages (up to max delay)
      return false;
    }

    // Low rate - flush immediately for responsiveness
    return true;
  }

  getFlushDelay(): number {
    // Dynamic: 16ms for high rate, 50ms for low rate
    if (this.messageRate > 20) return 16; // >20 msg/sec
    if (this.messageRate > 5) return 33;
    return 50; // Low rate: batch more, save resources
  }
}
```

**Success Metrics**:

```typescript
// 10 messages in 20ms should batch to 1-2 POSTs, not 3-4
const messageTimes = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];
const postCount = simulateFlushes(messageTimes);

expect(postCount).toBeLessThanOrEqual(2); // Batched efficiently
```

---

## Implementation Roadmap

### Week 1: Tier 1 Optimizations

**Day 1-2: HTTP Keep-Alive**

- Implement ConnectionPool class
- Add to DaemonRuntime
- Write tests for connection reuse

**Day 3-4: Parallel Flush**

- Refactor flushMessageBuffer to use Promise.allSettled
- Handle error cases
- Add concurrency limit (max 5 parallel)

**Day 5: Serialization Optimization**

- Add fast path for single-message payloads
- Benchmark vs standard JSON.stringify

**Success Criteria:**

```
Before: 67ms average daemon time
After:  40ms average daemon time (40% reduction)
```

### Week 2: Tier 2 Optimizations

**Day 1-2: Zero-Copy Buffers**

- Implement MessageBuffer with index-based consumption
- Test memory allocation

**Day 3-5: Intelligent Batching**

- Implement AdaptiveBatching
- A/B test vs fixed 33ms

**Success Criteria:**

```
Before: 40ms average daemon time
After:  30ms average daemon time (25% more reduction)
POST count reduced by 20%
```

### Week 3: Testing & Validation

**Day 1-3: Load Testing**

- 100 concurrent threads
- 1000 messages/sec throughput

**Day 4-5: Production Rollout**

- Canary deployment
- Monitor metrics

**Final Success Criteria:**

```
Daemon contribution: 67ms → 30ms (55% reduction)
E2E with current server: 233ms → 196ms
E2E with optimized server: 196ms → target <150ms
```

---

## Measurement Strategy

### Key Metrics to Track

1. **daemon_flush_time_ms** - Time from flush start to POST complete
2. **daemon_serialization_ms** - Time spent in JSON.stringify
3. **daemon_buffer_copy_bytes** - Memory copied per flush
4. **http_connection_reuse_rate** - % of POSTs using keep-alive
5. **parallel_flush_efficiency** - Time saved by parallel processing
6. **batch_efficiency** - Messages per POST ratio

### Benchmark Suite

```typescript
describe("daemon performance benchmarks", () => {
  it("flushes single message in <10ms", async () => {
    const elapsed = await measureFlush(1);
    expect(elapsed).toBeLessThan(10);
  });

  it("flushes 10 messages in <15ms", async () => {
    const elapsed = await measureFlush(10);
    expect(elapsed).toBeLessThan(15);
  });

  it("flushes 5 threads in parallel <40ms", async () => {
    const elapsed = await measureParallelFlush(5);
    expect(elapsed).toBeLessThan(40);
  });

  it("serializes large payload in <5ms", async () => {
    const elapsed = await measureSerialization(100);
    expect(elapsed).toBeLessThan(5);
  });

  it("reuses HTTP connections", async () => {
    const reuseRate = await measureConnectionReuse(10);
    expect(reuseRate).toBeGreaterThan(0.8); // 80% reuse
  });
});
```

---

## Risk Assessment

| Optimization            | Risk   | Mitigation                                                    |
| ----------------------- | ------ | ------------------------------------------------------------- |
| HTTP keep-alive         | Low    | Connection timeout handling, fallback to new connection       |
| Parallel flush          | Medium | Limit concurrency, proper error handling, ordering guarantees |
| Serialization fast-path | Low    | Fallback to standard JSON.stringify on error                  |
| Zero-copy buffers       | Medium | Careful index management, memory cleanup                      |
| Adaptive batching       | Low    | Min/max bounds on flush delay                                 |

---

## Definition of Done

### Tier 1 Complete ✅

- [ ] HTTP keep-alive: 10ms → 2ms per POST (after first)
- [ ] Parallel flush: 5 threads in <40ms
- [ ] Serialization: 30% faster on large payloads
- [ ] All new tests passing
- [ ] No regressions in 425 existing tests

### Tier 2 Complete ✅

- [ ] Zero-copy: Memory allocation reduced 30%
- [ ] Adaptive batching: 20% fewer POSTs
- [ ] Daemon contribution: 67ms → 40ms

### Tier 3 Complete ✅

- [ ] Binary protocol: 40% smaller payloads
- [ ] Pre-emptive flushing: 20ms perceived improvement
- [ ] Daemon contribution: 40ms → 30ms

### Final Success ✅

- [ ] **Daemon: 67ms → 30ms (55% improvement)**
- [ ] **E2E latency: 233ms → 196ms (with current server)**
- [ ] **Ready for server-side optimization to reach <150ms**

# Daemon Sandbox Communication Test Harness

A comprehensive test suite for non-LLM daemon-to-client communication.

## Purpose

Tests communication pathways from the sandbox/daemon to the client that are **not** LLM message streaming:

- **Startup logs** - Sandbox initialization, dependency checks, readiness signals
- **System messages** - Errors, warnings, status updates
- **Stderr handling** - Process stderr capture and forwarding
- **Tool output** - Bash commands, file operations, git operations
- **Meta events** - Token usage, rate limits, MCP server health
- **Lifecycle events** - Connection/disconnection, restarts
- **Performance** - Flush latency, message ordering, throughput

## Test Categories

### 1. Startup Logs (3 tests)

- `should stream sandbox initialization logs immediately`
- `should handle rapid log bursts during startup`
- `should flush startup logs within 33ms (messageFlushDelay)`

### 2. Stderr and Error Handling (3 tests)

- `should capture and forward stderr output`
- `should send custom-error when process crashes`
- `should handle spawn errors gracefully`

### 3. Tool Execution Output (3 tests)

- `should stream bash command output`
- `should stream file write confirmations`
- `should handle large tool output in chunks`

### 4. Meta Events (2 tests)

- `should be configured to handle token usage meta events`
- `should handle rate limit meta events`

### 5. Mixed Message Streams (2 tests)

- `should interleave system logs with assistant messages`
- `should maintain order across mixed message types`

### 6. Heartbeat and Keepalive (1 test)

- `should send heartbeat messages during long operations`

### 7. Performance and Latency (2 tests)

- `should handle 100 rapid messages without dropping`
- `should flush deltas within 16ms`

### 8. Sandbox Lifecycle (2 tests)

- `should handle sandbox disconnection`
- `should handle multiple sandbox restarts`

### 9. Edge Cases (3 tests)

- `should handle empty messages gracefully`
- `should handle malformed JSON output`
- `should handle extremely long single-line output`

## Running Tests

```bash
# Run all sandbox communication tests
cd packages/daemon
pnpm test --run --testNamePattern="daemon sandbox communication"

# Run specific test category
pnpm test --run --testNamePattern="startup logs"
pnpm test --run --testNamePattern="stderr"
pnpm test --run --testNamePattern="tool execution"

# Run with watch mode during development
pnpm test --testNamePattern="daemon sandbox communication"
```

## Test Utilities

### Message Builders

```typescript
createTestInput(overrides?)     // Build test input message
createTestStop()                // Build stop message
createStartupLog(phase, details) // Build startup log message
createSystemMessage(content)    // Build system message
createErrorMessage(error, info) // Build error message
createToolOutput(tool, output)  // Build tool result message
createMetaEvent(type, data)     // Build meta event
```

### Mock Helpers

```typescript
mockSpawnStdoutLine(message); // Simulate stdout from agent
mockSpawnStderr(data); // Simulate stderr from agent
mockSpawnError(error); // Simulate spawn error
mockSpawnClose(code); // Simulate process exit
getLastServerPostPayload(); // Get most recent POST payload
getAllServerPostPayloads(); // Get all POST payloads
```

## Key Configurations Tested

This test harness validates the optimized flush delays:

```typescript
messageFlushDelay: 33; // 30fps message batching
// enqueueDelta: 16ms   // 60fps delta streaming (inferred)
// enqueueMetaEvent: 16ms // 60fps meta event streaming (inferred)
```

## Adding New Tests

Example: Test for git status output streaming

```typescript
it("should stream git status output", async () => {
  await daemon.start();
  await writeToUnixSocket({
    unixSocketPath: runtime.unixSocketPath,
    dataStr: JSON.stringify(createTestInput()),
  });
  await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);

  // Simulate git status output
  mockSpawnStdoutLine({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "bash-git-status",
          content: "M src/index.ts\n?? new-file.ts",
          is_error: false,
        },
      ],
    },
    session_id: "test",
    parent_tool_use_id: "bash-git-status",
  });

  await sleep(50);

  const lastPayload = getLastServerPostPayload();
  expect(
    lastPayload?.messages.some((m) =>
      JSON.stringify(m).includes("bash-git-status"),
    ),
  ).toBe(true);
});
```

## CI/CD Integration

These tests run automatically with the full daemon test suite:

```bash
pnpm test --run  # Runs all tests including these 21
```

## Coverage Areas

- ✅ Unix socket message handling
- ✅ Message buffering and flush timing
- ✅ Delta streaming prioritization
- ✅ Error propagation
- ✅ Process lifecycle management
- ✅ Multi-message ordering
- ✅ Large payload handling
- ✅ Concurrent thread handling

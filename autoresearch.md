# Autoresearch: End-to-End Streaming Reliability (REAL Sandbox Testing)

## Objective

Validate that the **full streaming pipeline works reliably** with REAL infrastructure:
**Test → Docker Sandbox → Daemon → Agent → Stream → API → DB → Broadcast**

This is NOT a unit test - we actually spin up Docker containers and measure real-world reliability.

## What "Works" Means

| Stage               | Success Criteria                         |
| ------------------- | ---------------------------------------- |
| 1. Sandbox Creation | Docker container starts within 60s       |
| 2. Daemon Install   | Daemon binary written and started        |
| 3. Daemon Ready     | Daemon responds to ping within 30s       |
| 4. Message Send     | All messages sent to daemon successfully |
| 5. Flush            | Daemon flushes messages to API           |
| 6. Reliability      | ≥80% of messages delivered end-to-end    |

## Test Architecture (REAL)

```
┌─────────────────────────────────────────────────────────────┐
│  Test Runner (Vitest)                                        │
│  ┌──────────────────┐    ┌──────────────────────────────┐ │
│  │  Docker Sandbox  │    │  Real Terragon Daemon        │ │
│  │  (Node.js + Git) │───→│  - Installed in sandbox      │ │
│  │                  │    │  - Background process          │ │
│  └──────────────────┘    │  - Writes to log file        │ │
│           ↑              └──────────────────────────────┘ │
│           │                         │                      │
│           │ Send messages           │ Flush to API         │
│           │ (via Unix socket)       │ (HTTP POST)         │
│           │                         ↓                      │
│           │              ┌──────────────────────────────┐ │
│           └──────────────│  Next.js API Route           │ │
│              (daemon log)│  /api/daemon-event           │ │
│                          └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Metrics

- **Primary**: `reliability_score` (0-100) - % of messages that flow through entire pipeline
- **Secondary**:
  - `sandbox_startup_ms` - Time to create Docker container
  - `daemon_ready_ms` - Time from daemon start to first ping response
  - `messages_sent` - Messages successfully sent to daemon
  - `messages_flushed` - Messages flushed to API (read from daemon log)
  - `flush_latency_ms` - Time for daemon to flush all messages
  - `error_count` - Number of errors during test

## How to Run

`./autoresearch.sh` - Runs the REAL sandbox E2E test

The test:

1. Checks Docker is available and running
2. Starts PostgreSQL/Redis test containers (if needed)
3. Spins up a Docker sandbox with the Terragon daemon
4. Sends messages to the daemon via Unix socket
5. Reads daemon logs to verify message flushing
6. Measures delivery reliability

## Files in Scope

| File                                                        | Purpose                                    |
| ----------------------------------------------------------- | ------------------------------------------ |
| `packages/sandbox/src/daemon.ts`                            | Daemon installation and message sending    |
| `packages/sandbox/src/providers/docker-provider.ts`         | Docker sandbox provider                    |
| `apps/www/test/integration/e2e-sandbox-reliability.test.ts` | REAL E2E test                              |
| `packages/daemon/src/daemon.ts`                             | Core daemon with buffering and flush logic |

## Off Limits

- **DO NOT** change authentication/authorization logic
- **DO NOT** modify database schema
- **DO NOT** break backward compatibility
- **DO NOT** require real LLM API calls (we use mock messages)

## Constraints

- Docker must be available and running
- Test must complete within 3 minutes per run
- Must clean up containers after test
- All existing tests must still pass

## What's Been Tried

### Baseline (Established)

- Unit test: 100% reliability with 1k deltas (1.4M events/sec)
- This was just the reducer, not real infrastructure

### Current: REAL Sandbox Testing

- Test spins up actual Docker sandbox
- Installs real daemon binary
- Sends real messages via Unix socket
- Measures actual daemon log output

## Hypotheses to Test

1. **Sandbox Startup Time**: Can we reduce from ~30s to <15s?
2. **Daemon Ready Time**: Why does daemon take 5-10s to respond to ping?
3. **Message Flush Reliability**: Does daemon reliably flush all messages?
4. **Connection Stability**: Are there transient failures in daemon socket?
5. **Burst Handling**: Can daemon handle 20 msg/sec without dropping?

## Experiment Log

<!-- Log entries will be added here by the experiment loop -->

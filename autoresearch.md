# Autoresearch: End-to-End Streaming Reliability

## Objective

Validate that the full streaming pipeline works reliably end-to-end:
**Frontend Message → Sandbox Spin-up → Agent Start → Message Streaming → Frontend Visibility**

Focus on **functional correctness and smoothness**, not micro-latency optimizations.

## What "Works" Means

| Stage                   | Success Criteria                              |
| ----------------------- | --------------------------------------------- |
| 1. Task Creation        | Frontend optimistic UI appears immediately    |
| 2. Sandbox Provisioning | Docker sandbox starts within 30s              |
| 3. Agent Spawn          | Daemon receives message, agent process starts |
| 4. Message Streaming    | All agent stdout messages flush to API        |
| 5. DB Persistence       | Messages saved with correct sequencing        |
| 6. Broadcast Delivery   | WebSocket delivers patches to client          |
| 7. Frontend Render      | Messages visible in chat UI                   |
| 8. Completion Signal    | Terminal status (done/error/stop) received    |

## Failure Modes We're Hunting

1. **Silent message drops** - Agent generates output but it never reaches frontend
2. **Ordering bugs** - Messages appear out of sequence
3. **Stuck states** - Stream hangs mid-way, no terminal signal
4. **Frontend desync** - Backend has messages, frontend doesn't show them
5. **Buffer overflow** - High-velocity streams lose messages
6. **Sandbox/agent startup failures** - Silent crashes during initialization

## Test Architecture

### Test Setup (Integration Test)

```
┌─────────────────────────────────────────────────────────────┐
│  Test Harness                                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐ │
│  │  Frontend    │───→│   Next.js    │───→│   Docker     │ │
│  │  (simulated) │    │   API Route  │    │   Sandbox    │ │
│  └──────────────┘    └──────────────┘    └──────────────┘ │
│         ↑                      │                │          │
│         │                      ↓                ↓          │
│         │              ┌──────────────┐    ┌──────────────┐  │
│         └──────────────│   Broadcast  │    │   Daemon     │  │
│            (validate) │   (PartyKit) │    │   (in-sandbox)│ │
│                       └──────────────┘    └──────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Test Flow

1. Create test thread via API
2. Start Docker sandbox with daemon
3. Send daemon message (simulating user prompt)
4. Collect all daemon→API POSTs
5. Validate DB state after each POST
6. Simulate broadcast→frontend delivery
7. Assert all messages rendered in correct order

## Metrics

- **Primary**: `reliability_score` (0-100) - % of successful end-to-end deliveries
- **Secondary**:
  - `messages_expected` - Total messages agent should generate
  - `messages_delivered` - Messages that reached frontend
  - `messages_persisted` - Messages saved to DB
  - `ordering_correct` - Boolean, all messages in sequence
  - `terminal_received` - Boolean, completion signal arrived
  - `sandbox_startup_ms` - Time from creation to agent start
  - `end_to_end_ms` - Total time from prompt to completion

## How to Run

`./autoresearch.sh` - Runs the E2E streaming reliability test

The test:

1. Starts Docker services (PostgreSQL, Redis)
2. Runs the integration test suite via vitest
3. Measures delivery reliability across N test runs
4. Outputs `METRIC reliability_score=X`

## Files in Scope

| File                                                | Purpose                             |
| --------------------------------------------------- | ----------------------------------- |
| `packages/daemon/src/daemon.ts`                     | Message buffering and flush logic   |
| `apps/www/src/app/api/daemon-event/route.ts`        | API route receiving daemon events   |
| `apps/www/src/server-lib/handle-daemon-event.ts`    | Event processing and DB persistence |
| `packages/shared/src/broadcast/broadcast-server.ts` | WebSocket broadcast publishing      |
| `apps/www/test/integration/`                        | Integration test infrastructure     |

## Off Limits

- **DO NOT** change authentication logic
- **DO NOT** modify database schema
- **DO NOT** break backward compatibility
- **DO NOT** require real LLM API calls (use mock agents)

## Constraints

- All tests must pass in CI (including existing ones)
- Docker must be available for sandbox tests
- Tests must be deterministic (no flaky assertions)
- Max test duration: 60 seconds per run

## What's Been Tried

### Baseline (Established)

- Basic daemon message buffering with 33ms flush delay
- Integration test framework with replayer
- Stress tests for reducer performance

### Hypotheses to Test

1. **Message Buffer Size Limit**: Flush immediately when buffer ≥ 10 messages
2. **Periodic Flush**: Add 100ms max-wait timer to prevent stuck buffers
3. **Connection Health Check**: Detect and retry failed daemon-event POSTs faster
4. **Frontend Optimistic Updates**: Show messages immediately before broadcast confirms
5. **Startup Timeout**: Kill stuck sandbox startup after 45s

## Experiment Log

<!-- Log entries will be added here by the experiment loop -->

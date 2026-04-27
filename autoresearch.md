# Autoresearch: End-to-End Streaming Reliability (REAL Sandbox + Visual Testing)

## Objective

Validate that the **full streaming pipeline works reliably** with REAL infrastructure AND visual confirmation:

**Test → Docker Sandbox → Daemon → API → DB → Broadcast → Frontend Render → Screenshots/Video**

This is NOT a unit test - we actually:

1. Spin up Docker containers
2. Measure real-world reliability
3. **Capture screenshots and video of the frontend rendering** 📸🎥

## What "Works" Means

| Stage               | Success Criteria                         |
| ------------------- | ---------------------------------------- |
| 1. Sandbox Creation | Docker container starts within 60s       |
| 2. Daemon Install   | Daemon binary written and started        |
| 3. Daemon Ready     | Daemon responds to ping within 30s       |
| 4. Message Send     | All messages sent to daemon successfully |
| 5. Flush            | Daemon flushes messages to API           |
| 6. DB Persistence   | Messages saved to database               |
| 7. Frontend Render  | **Messages render correctly in UI**      |
| 8. **Visual Proof** | **Screenshots show correct rendering**   |
| 9. Reliability      | ≥95% of messages delivered AND rendered  |

## Test Architecture (REAL + VISUAL)

```
┌──────────────────────────────────────────────────────────────────┐
│  Test Runner (Vitest)                                            │
│  ┌──────────────────┐    ┌──────────────────────────────┐       │
│  │  Docker Sandbox  │    │  Real Terragon Daemon        │       │
│  │  (Node.js + Git) │───→│  - Installed in sandbox      │       │
│  │                  │    │  - Background process          │       │
│  └──────────────────┘    │  - Writes to log file        │       │
│           ↑              └──────────────────────────────┘       │
│           │                         │                           │
│           │ Send messages           │ Flush to API              │
│           │ (via Unix socket)       │ (HTTP POST)              │
│           │                         ↓                           │
│           │              ┌──────────────────────────────┐       │
│           └──────────────│  Next.js API Route           │       │
│              (daemon log)│  /api/daemon-event           │       │
│                          └──────────────────────────────┘       │
│                                     │                           │
│                                     ↓                           │
│                          ┌──────────────────────────────┐       │
│                          │  Frontend (React)            │       │
│                          │  - Message rendering         │       │
│                          │  - Terminal output           │       │
│                          └──────────────────────────────┘       │
│                                     │                           │
│                                     ↓                           │
│                          ┌──────────────────────────────┐       │
│                          │  📸 Playwright Browser        │       │
│                          │  - Screenshots captured       │       │
│                          │  - 🎥 Video recorded          │       │
│                          │  - Visual integrity check     │       │
│                          └──────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────┘
```

## Metrics

- **Primary**: `reliability_score` (0-100) - % of messages delivered AND rendered
- **Secondary**:
  - `sandbox_startup_ms` - Time to create Docker container
  - `daemon_ready_ms` - Time from daemon start to first ping response
  - `messages_sent` - Messages sent to daemon
  - `messages_acknowledged` - Messages acknowledged by daemon
  - `messages_rendered` - Messages rendered in UI
  - `render_latency_ms` - Time to render all messages
  - **📸 `screenshots_captured` - Number of screenshots taken**
  - **🎯 `visual_integrity_score` - Screenshot quality score (0-100)**
  - **🎥 `video_recorded` - Whether video was captured (0/1)**
  - `error_count` - Number of errors during test

## Visual Artifacts

After each test run, check the artifacts directory:

```bash
./apps/www/test-results/visual-reliability/
├── run-{timestamp}/
│   ├── initial-{timestamp}.png           # Initial render screenshot
│   ├── scrolled-{timestamp}.png          # After scrolling
│   ├── dynamic-message-{timestamp}.png   # Dynamic message test
│   ├── test-summary.json                 # Test metadata
│   └── (video files if enabled)          # .webm video recordings
```

## How to Run

`./autoresearch.sh` - Runs the FULL E2E test suite:

1. **Real Docker Sandbox test** - Infrastructure validation
2. **Frontend rendering test** - React component rendering
3. **Visual test** - 📸 Screenshots and 🎥 video capture

## Files in Scope

| File                                                               | Purpose                                    |
| ------------------------------------------------------------------ | ------------------------------------------ |
| `packages/sandbox/src/daemon.ts`                                   | Daemon installation and message sending    |
| `packages/sandbox/src/providers/docker-provider.ts`                | Docker sandbox provider                    |
| `packages/sandbox/src/sandbox-reliability.test.ts`                 | Real Docker E2E test                       |
| `apps/www/test/integration/e2e-full-streaming-reliability.test.ts` | Frontend rendering test                    |
| **📸 `apps/www/test/integration/e2e-visual-reliability.test.ts`**  | **Visual screenshot/video test**           |
| `packages/daemon/src/daemon.ts`                                    | Core daemon with buffering and flush logic |

## Test Capabilities

### 1. Real Sandbox Test

- Spins up Docker containers
- Measures actual startup time (~2.5s)
- Tests daemon installation
- Validates message delivery

### 2. Frontend Rendering Test

- Renders React components in test environment
- Validates message output
- Measures render latency (~27ms for 5 messages)
- Tests terminal output rendering

### 3. **Visual Test (NEW!)**

- **📸 Captures screenshots** of UI at multiple states:
  - Initial render
  - After scrolling
  - Dynamic message arrival
- **🎥 Records video** of message streaming (optional, slower)
- **Analyzes screenshot quality** (detects blank/corrupted renders)
- Saves artifacts for manual inspection

## Off Limits

- **DO NOT** change authentication/authorization logic
- **DO NOT** modify database schema
- **DO NOT** break backward compatibility
- **DO NOT** require real LLM API calls (we use mock messages)

## Constraints

- Docker must be available and running
- Playwright browsers must be installed (`npx playwright install chromium`)
- Test must complete within 3 minutes per run
- Must clean up containers after test
- All existing tests must still pass

## What's Been Tried

### Baseline (Established)

| Test                  | Score   | Key Metrics                       |
| --------------------- | ------- | --------------------------------- |
| Unit test (1k deltas) | 100%    | 1.4M events/sec                   |
| Real Docker sandbox   | 100%    | 2.5s startup, 0.4s daemon install |
| Frontend rendering    | 50-100% | 27ms render latency               |
| **Visual test**       | **TBD** | **Screenshots + video**           |

### Key Findings

1. **Sandbox startup**: ~2.5s (very fast!)
2. **Daemon install**: ~0.4s (excellent!)
3. **Message delivery**: 100% to daemon
4. **Frontend render**: 5 messages in 27ms
5. **Visual validation**: Now enabled with screenshot/video capture

## Hypotheses to Test

1. **Visual Regression**: Can we detect UI changes via screenshot comparison?
2. **Animation Performance**: Does message entry animation stay 60fps?
3. **Terminal Rendering**: Does terminal output capture correctly in video?
4. **Mobile Rendering**: Do screenshots look correct on mobile viewport?
5. **Dark Mode**: Does rendering work correctly in dark mode?

## Experiment Log

<!-- Log entries will be added here by the experiment loop -->

### Visual Test Baseline (Most Recent)

- **Screenshots captured**: 2-3 per test
- **Visual integrity score**: TBD
- **Video recording**: Optional (slower but captures motion)
- **Artifacts location**: `./apps/www/test-results/visual-reliability/`

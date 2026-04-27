# Autoresearch Ideas & Backlog

## Current Experiment: Visual Testing

### ✅ Implemented

- **Screenshot capture** at multiple UI states
- **Video recording** of message streaming (8-10 second WebM files)
- **Visual integrity analysis** (file size heuristics: 470KB+ = valid content)
- **Artifacts saved** to `test-results/visual-streaming-direct/run-*/`
- **Message detection** working: 2 message elements (user + agent block)

### ✅ ACHIEVED: Messages Rendering in ChatUI

**Root causes fixed:**

1. Added `projectedMessages` column to match `messages` (prevents `skipSeededAssistantText` filter)
2. Added user message before agent messages (required for conversation flow)
3. Skip `agent_event_log` creation (avoids triggering `hasCanonicalReplayProjection` which would bypass `thread_chat.messages`)

### Current Baseline

- **Video size**: ~480KB
- **Duration**: 8 seconds
- **Messages found**: 2 (1 user + 1 agent cluster with 5 messages)
- **Screenshot size**: ~120KB
- **Full Terragon interface rendering**: sidebar + task list + chat UI + prompt box

### Next Steps for Visual Testing

1. **Screenshot Comparison**: Implement pixel-by-pixel diff to detect UI regressions
2. **Animation Performance**: Measure frame rates during message entry animations
3. **Mobile Viewport**: Capture screenshots in mobile dimensions
4. **Dark Mode**: Test rendering in both light and dark themes
5. **Accessibility**: Run axe-core checks on rendered output

## Optimization Targets

### Daemon Flush Performance

- Test 8ms vs 16ms vs 33ms flush delay under load
- Measure message coalescing effectiveness
- Test max throughput before buffer overflow

### Sandbox Startup

- Profile Docker image layers
- Test if pre-warmed containers start faster
- Measure daemon install time optimization

### Frontend Rendering

- Test React re-render count during streaming
- Profile message component mount/unmount
- Measure virtual list performance with 100+ messages

## Reliability Edge Cases

### Network Failure Scenarios

- Simulate API 500 errors during flush
- Test daemon retry logic effectiveness
- Measure recovery time from failure

### High-Velocity Streams

- Test 100 messages/sec throughput
- Measure memory usage during bursts
- Test browser tab performance with heavy streams

### Concurrent Sessions

- Test multiple sandboxes in parallel
- Measure resource contention
- Test broadcast channel limits

## Ideas for Future Experiments

1. **Compression**: Test gzip compression for large message payloads
2. **Caching**: Implement and test message deduplication cache
3. **WebSockets**: Compare WebSocket vs HTTP polling for daemon
4. **CDN**: Test if static assets benefit from CDN delivery
5. **Prefetching**: Test prefetching thread history on mount

## Notes from Current Session

- Baseline established with 100% reliability
- Visual testing now captures screenshots and video
- All 3 test types passing (sandbox, rendering, visual)
- Artifacts located in: ./apps/www/test-results/visual-reliability/
- Ready to run experiments with full visual validation

## Live LLM Turn Test - Implementation Notes

### Status: Partially Working

**What works:**

- ✅ API endpoint creates test user, thread, sandbox
- ✅ Docker sandbox spawns successfully
- ✅ Daemon installs and starts
- ✅ Message sent to daemon (daemon receives it)
- ✅ Playwright captures video (3.6MB, 60 seconds)
- ✅ Frontend loads with auth

**Blocker: Daemon Authentication**
The daemon connects to `/api/daemon-event` but gets 401 Unauthorized.
The daemon uses `X-Daemon-Token` header which must be a valid API key.

**Required to complete:**

1. Create API key for test user via `auth.api.createKey()`
2. Pass API key to daemon message as `token` field
3. Ensure daemon uses this token for all daemon-event requests

**Alternative approaches:**

1. Use test auth mode with `X-Terragon-Test-Daemon-Auth` header
2. Mock the daemon-event endpoint for testing
3. Use the existing sandbox-reliability test pattern (direct message send, no streaming)

**Current value:**
The test infrastructure is valuable - it spawns real sandboxes and captures video.
For autoresearch baseline, the static visual test (e2e-visual-streaming-direct) is sufficient.

## Live LLM Turn Test - UPDATE: Authentication Debugged

### Progress Made

- ✅ Fixed API key creation with proper metadata structure:
  - `kind: "daemon-run"`
  - `transportMode: "legacy"`
  - `providers: ["anthropic"]`
- ✅ Fixed daemon kill/restart flow
- ✅ Fixed `restartDaemonIfNotRunning` call signature (needs `{ session, options }`)
- ❌ **Still failing**: Daemon not picking up `DAEMON_TOKEN` env var

### Root Cause

The daemon process needs `DAEMON_TOKEN` in its environment at startup, but the
`restartDaemonIfNotRunning` -> `startDaemon` -> `runBackgroundCommand` chain isn't
passing the env vars correctly to the spawned process.

### What's Working

The **static visual test** (`e2e-visual-streaming-direct.test.ts`) is fully operational:

- Spawns sandbox ✓
- Creates thread with messages ✓
- Captures 10s video (472KB) ✓
- Validates 2 messages in ChatUI ✓

### Recommendation

For autoresearch baseline, the **static visual test is sufficient**.

The live LLM test requires either:

1. Fix daemon env var propagation in sandbox package
2. Use test auth bypass instead of real API keys
3. Mock the daemon-event endpoint for testing

# AG UI Testing Plan

**Generated:** 2026-04-20
**Scope:** `apps/www` chat runtime, replay, and realtime behavior after the AG UI cutover

## Goal

Prove that Terragon's chat UI behaves correctly when the AG UI path is the runtime authority:

- daemon posts canonical events through `/api/daemon-event`
- replay comes from `/api/thread-replay`
- token tails come from `token_stream_event`
- React hydrates from canonical projections instead of deleted `daemon-delta` / `message-stream` flows

This plan is intentionally biased toward the new path only. We do not spend browser or integration time on deleted legacy transports.

## What Must Be True Before We Call This Stable

1. A fresh turn can stream, reconnect, and finish without `daemon-delta`.
2. A refresh or socket reconnect rehydrates the same transcript the live session would have produced.
3. Token tails only finalize after assistant materialization, not on terminal-only appends.
4. Thread switching and stale cursors do not cross-pollute chats.
5. Delivery-loop shell state, transcript state, and replay state stay coherent under the same canonical run.
6. Supported transports normalize to the same UI contract.

## Out Of Scope

- Browser coverage for deleted `/api/daemon-delta`
- Browser coverage for deleted `apps/www/src/lib/message-stream.ts`
- Long-term backwards compatibility for pre-v2 daemons
- Legacy `threadChat.messages` behavior except where it still exists as a temporary fallback read

## Risk Map

```text
Daemon
  -> /api/daemon-event
      -> canonical persistence
      -> token tail persistence
      -> compatibility bridge
      -> broadcast patches

Client
  -> initial thread shell/chat query
  -> useRealtimeThread()
      -> socket patches
      -> /api/thread-replay gap fill
  -> ChatUI projection render

Highest-risk seams
  1. canonical event persisted but UI replay cursor wrong
  2. token tail assigned/finalized against wrong transcript boundary
  3. reconnect or chat switch applies stale replay into active chat
  4. shell/delivery-loop invalidation diverges from transcript timeline
```

## Existing Automated Coverage

These tests already cover a good part of the cutover and should remain the base gate:

- `apps/www/src/app/api/daemon-event/route.test.ts`
  - canonical persistence before legacy handling
  - canonical-only acknowledgements
  - deduplication and failure-closed persistence
  - token-tail finalization boundaries
- `apps/www/src/app/api/thread-replay/route.test.ts`
  - canonical replay entries
  - active chat scoping
  - pending delta replay for active run
- `apps/www/src/hooks/useRealtime.test.ts`
  - reconnect replay
  - canonical replay plus delta replay merge
  - stale replay dropping
  - lower-seq reseeding on chat switch
- `apps/www/src/hooks/use-delivery-loop-status-realtime.test.tsx`
  - delivery-loop invalidation against realtime patches
- `apps/www/src/server-lib/daemon-event-db-preflight.test.ts`
  - preflight retry semantics
- `packages/daemon/src/daemon.test.ts`
  - canonical envelope retries
  - delta-only flushes through daemon-event
  - envelope identity stability across retries and restarts
- `packages/shared/src/model/thread-page.test.ts`
  - projected message hydration from canonical replay rows

## Coverage Gaps To Close

The current missing pieces are higher-level than route correctness:

1. ACP parity
   - We have Codex and Claude replay fixtures in `apps/www/test/integration/recordings/`.
   - We do not yet have an ACP recording proving the same UI contract.
2. Real browser reconnect smoke
   - Hook tests cover replay logic, but they do not prove the visible transcript survives a real browser refresh during streaming.
3. Thread switch under load
   - Hook coverage exists, but we still want one browser proof that changing chats during an in-flight replay does not leak transcript or token tail state.
4. Mobile and keyboard coverage
   - The replay path changed; we should prove the transcript, prompt box, and secondary panel still behave on a narrow viewport and keyboard-only navigation.
5. Negative browser assertions
   - We should explicitly verify that no browser path tries to call deleted realtime endpoints.

## Test Layers

### Layer 1: Contract and projection tests

Purpose: catch broken daemon envelopes, replay cursors, projection reads, and DB drift before the browser is involved.

Required gate:

```bash
pnpm -C apps/www test -- \
  src/app/api/daemon-event/route.test.ts \
  src/app/api/thread-replay/route.test.ts \
  src/hooks/useRealtime.test.ts \
  src/hooks/use-delivery-loop-status-realtime.test.tsx \
  src/server-lib/daemon-event-db-preflight.test.ts

pnpm -C packages/daemon exec vitest run src/daemon.test.ts
pnpm -C packages/shared test -- \
  src/model/agent-event-log.test.ts \
  src/model/thread-page.test.ts
```

### Layer 2: Replay-harness integration tests

Purpose: prove recorded daemon traffic produces the expected UI contract through the real Next.js route stack.

Current fixtures:

- `apps/www/test/integration/recordings/codex-collab-agent-turn.jsonl`
- `apps/www/test/integration/recordings/claude-code-standard-turn.jsonl`

Current suite:

```bash
pnpm -C apps/www test -- \
  test/integration/codex-turn.test.tsx \
  test/integration/claude-code-turn.test.tsx
```

Add next:

- `apps/www/test/integration/recordings/acp-standard-turn.jsonl`
- `apps/www/test/integration/acp-turn.test.tsx`

ACP should be treated as a required parity fixture, not a nice-to-have. The point of the AG UI path is that transport-specific output no longer changes the UI contract.

### Layer 3: Real browser smoke

Purpose: prove the actual rendered app survives refreshes, reconnects, viewport changes, and user timing.

Run against local `apps/www` with a seeded recording or a real local sandbox thread. Use sub agents later if we want to fan this out.

#### Group A: Transcript and replay

1. `AGUI-BR-001` New turn streams text into the transcript and ends with the same final assistant content after completion.
2. `AGUI-BR-002` Refresh during streaming rehydrates from `/api/thread-replay` and preserves already-seen transcript plus pending token tail.
3. `AGUI-BR-003` Reconnect after socket drop resumes from the last canonical cursor without duplicate transcript blocks.
4. `AGUI-BR-004` Refresh after completion shows the same transcript with no missing terminal output.

#### Group B: Active chat and shell coherence

1. `AGUI-BR-005` Switching to another chat while replay is in flight does not apply the previous chat's transcript or delta tail.
2. `AGUI-BR-006` Switching back to the original chat reseeds from that chat's canonical message sequence rather than the newer chat's cursor.
3. `AGUI-BR-007` Thread shell updates, transcript updates, and delivery-loop status updates converge on the same visible thread state.
4. `AGUI-BR-008` Secondary panel and diff affordances still match shell freshness after realtime updates.

#### Group C: Failure handling and UX guardrails

1. `AGUI-BR-009` Replay endpoint failure falls back to live patches instead of blanking the transcript.
2. `AGUI-BR-010` Socket transport issues surface as warnings only and do not explode the page with opaque console errors.
3. `AGUI-BR-011` Narrow viewport keeps transcript readable, prompt usable, and side panels non-blocking.
4. `AGUI-BR-012` Keyboard-only navigation can reach the transcript, prompt box, stop/retry controls, and any open panel controls.

### Layer 4: Negative assertions

Purpose: prove the deleted paths stay deleted.

Every browser run should assert:

- no network request hits `/api/daemon-delta`
- no network request expects `message-stream`
- no duplicate transcript block appears after refresh or reconnect
- no console error indicates a replay schema mismatch

## Recommended Browser Procedure

### Local smoke

1. Start the app and any required support services.
2. Open a thread backed by one of the integration recordings or a live local run.
3. Run Group A first, because replay correctness is the highest-risk seam.
4. Run Group B second, because thread switching and delivery-loop invalidation are the easiest ways to ship stale state.
5. Run Group C last on both desktop and mobile viewport.

### Recording refresh procedure

When the canonical event schema changes materially:

1. Re-capture the affected transport using:

```bash
pnpm -C apps/www recorder --out /tmp/ag-ui-recording.jsonl --forward-to http://localhost:3000/api/daemon-event
```

2. Promote the fixture into `apps/www/test/integration/recordings/`.
3. Re-run the replay integration tests before any browser pass.
4. Only then refresh any browser snapshots or smoke notes.

## CI Shape

Minimum CI gate for AG UI changes:

```bash
pnpm -C apps/www test -- \
  src/app/api/daemon-event/route.test.ts \
  src/app/api/thread-replay/route.test.ts \
  src/hooks/useRealtime.test.ts \
  src/hooks/use-delivery-loop-status-realtime.test.tsx \
  src/server-lib/daemon-event-db-preflight.test.ts \
  test/integration/codex-turn.test.tsx \
  test/integration/claude-code-turn.test.tsx

pnpm -C packages/daemon exec vitest run src/daemon.test.ts
pnpm -C packages/shared test -- \
  src/model/agent-event-log.test.ts \
  src/model/thread-page.test.ts

pnpm tsc-check
```

Target follow-up gate once ACP parity lands:

```bash
pnpm -C apps/www test -- test/integration/acp-turn.test.tsx
```

## Ship Criteria

We call the AG UI UI path ready when all of the following are true:

1. Layer 1 and Layer 2 gates pass in CI.
2. Browser Groups A, B, and C pass on desktop.
3. Group C passes on a mobile viewport.
4. ACP has the same replay-harness coverage Codex and Claude already have.
5. No smoke run observes calls to deleted legacy endpoints.

## Immediate Next Moves

1. Add ACP replay fixture and test.
2. Run a real browser smoke focused on Group A and Group B before broadening coverage.
3. If Group A fails, debug replay cursor ownership first; if Group B fails, debug chat-context reseeding first.

---
title: "ADR: Runtime Owns Writes (AG-UI POST → followUp Adapter)"
type: adr
status: proposed
date: 2026-04-30
supersedes-decision-in:
  - apps/www/src/app/api/ag-ui/[threadId]/route.ts (POST = GET)
related:
  - docs/plans/2026-04-27-refactor-chat-layer-consolidated-plan.md
  - docs/plans/2026-04-28-phase-5-readiness.md
---

# ADR: Runtime Owns Writes (AG-UI POST → followUp Adapter)

## TL;DR

The AG-UI POST handler stops being an alias for GET and starts driving real
writes. POST will parse the AG-UI `RunAgentInput` body, hand it to a new
`runFollowUpFromAgUiInput()` adapter that calls the existing `followUp()`
server action behind an advisory lock, then fall through to the same SSE
stream GET serves today. This unblocks composer adoption (`ComposerPrimitive.Root`

- runtime `append`/`cancel`) without giving up the server-initiated invariant.

## Context (today)

- `apps/www/src/app/api/ag-ui/[threadId]/route.ts:1771` exports
  `POST = GET`. The comment block at lines 1763–1770 documents the rationale:
  cursor state lives in query params, runs are initiated by server actions,
  and the POST body is treated as ceremony to open the SSE stream.
- The client-provided `RunAgentInput` body is discarded server-side. The
  AG-UI `HttpAgent.runAgent()` call has no effect on backend run state.
- `followUp()` (`apps/www/src/server-actions/follow-up.ts` →
  `apps/www/src/server-lib/follow-up.ts`) and `stopThread()` are the
  authoritative write paths. Both run through the delivery loop and write
  through the existing single-writer pipeline.
- The dedup invariant today is the thread status enum: `isAgentWorking()`
  rejects a follow-up if the thread is already running. The runtime is a
  read-side projection; it does not need to coordinate with itself because
  it cannot write.
- The integration harness at `apps/www/test/integration/` replays recorded
  daemon-event POSTs through the real Next.js route and chat UI. It
  depends on POST being a stream-only ceremony.

## Decision

Reverse the prior decision. The POST handler becomes a real write path:

1. **Split POST from GET.** POST gets its own handler that runs an adapter
   step before the existing SSE plumbing.
2. **Adapter: `runFollowUpFromAgUiInput()`.** New module under
   `apps/www/src/app/api/ag-ui/[threadId]/`. Responsibilities:
   - Parse the AG-UI `RunAgentInput` body. Tolerate empty bodies (treat as
     "open stream only", matching today's behavior).
   - Validate ownership: session user must own the thread; `runId` (if
     present in the body) must belong to this thread.
   - Acquire a Redis advisory lock keyed on `threadChatId`. Lock TTL is
     short (≤ 5s); contention returns immediately rather than queuing.
   - Extract the latest user message + metadata (selected agent, model,
     attachments) from the AG-UI input.
   - Call `followUp()` with the extracted payload. `followUp()` retains
     full responsibility for status transitions, persistence, and dispatch.
   - Release the lock on completion (success or failure).
3. **Cancel mirror.** A symmetric adapter (`runStopFromAgUiCancel()` or
   inline in the cancel route) wires the runtime's `cancel()` to
   `stopThread()`. Same ownership and lock pattern, no body parse.
4. **Replay header gate.** Requests carrying `X-Terragon-Test-Replay: 1`
   skip the adapter and fall straight through to the SSE handler. The
   integration harness sets this header on every recorded POST so existing
   recordings stay valid without re-capture.
5. **Fall-through.** After the adapter returns (or is skipped), POST runs
   the same SSE pipeline GET runs today.

## Why we're reversing the prior decision

The prior decision was correct for the world it was made in: the runtime
was read-only, all writes flowed through server actions, and POST = GET
was the cheapest way to satisfy AG-UI's HTTP transport contract. Three
things changed.

- **Composer adoption is blocked without runtime writes.** Phase 5 of the
  consolidated chat plan wraps the prompt box in `ComposerPrimitive.Root`
  with `Send`, `Cancel`, and `AttachmentDropzone`. Those primitives call
  `runtime.append()` and `runtime.cancel()`, which the AG-UI runtime
  translates into POST and DELETE requests. With `POST = GET`, those calls
  are silent no-ops. The composer cannot ship.
- **Half-state is worse than either endpoint.** A composer that uses
  primitives but routes submission through a parallel `followUp()` server
  action call is wrapping a box, not building on top. It keeps two write
  paths alive, doubles the failure surface, and forces the integration
  harness to mock both.
- **The server-initiated invariant is preserved through different
  mechanics.** Today the status enum is the only dedup gate. Under this
  ADR, the advisory lock holds the dedup window before the status
  transition fires inside `followUp()`. Same invariant, different layer.
  The runtime never bypasses `followUp()` — it calls it.

## Risks and mitigations

| Risk                                                     | Mitigation                                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Lost dedup window between POST arrival and status flip   | Redis advisory lock on `threadChatId` held across the `followUp()` call; second POST contends and returns 409.                               |
| Runtime bypasses queue / status check                    | Adapter calls `followUp()` exactly as a server action does. Status `isAgentWorking()` check moves into the POST handler before lock release. |
| Replay ambiguity (recordings have bodies + query params) | Query params win over body. Replay header forces adapter skip; recorded bodies are inert.                                                    |
| Cross-user `runId` smuggling via body                    | Ownership check rejects any `runId` not bound to the session user's thread before the lock is acquired.                                      |
| Lifecycle recovery (sandbox eviction mid-run)            | Inherits existing `followUp()` recovery path. Adapter is a thin wrapper; no new recovery logic.                                              |
| Lock orphaned by handler crash                           | Lock TTL ≤ 5s; `followUp()` itself is fast (it enqueues, does not wait for the run). Long ops happen post-release.                           |
| Composer double-submit during network hiccup             | Runtime `append` is idempotent on the client; advisory lock absorbs duplicates on the server.                                                |

## What's NOT changing

- `followUp()` and `stopThread()` server actions stay. They are the
  targets of the adapter, not the bypass.
- The thread status enum + `isAgentWorking()` stays as the second-line
  dedup gate. Lock + status form a defense-in-depth pair.
- The integration harness recordings stay valid. The replay header gate
  exists precisely so we don't re-record.
- `apps/www/src/components/ai-elements/markdown-renderer.tsx` (streamdown)
  stays. It's a separate divergence from assistant-ui and unrelated to
  write ownership. Re-evaluate it in its own ADR if at all.
- The single-writer DB pipeline (delivery loop v3) stays. The adapter
  writes through `followUp()`, which writes through the same pipeline.

## Rollout

**Wave 1 — Plumbing (no behavior change).**

- New file: `apps/www/src/app/api/ag-ui/[threadId]/follow-up-adapter.ts`
  containing `runFollowUpFromAgUiInput()`. Not yet called.
- New file: `apps/www/src/components/chat/use-composer-queue.ts` (hook
  scaffold for the multi-message queue layered above `runtime.append`).
- This ADR.
- Acceptance: build passes, no behavior change, no test changes.

**Wave 2 — POST splits from GET.**

- `route.ts:1771` `export const POST = GET;` deleted.
- New `export async function POST(req, ctx)` calls
  `runFollowUpFromAgUiInput()`, then delegates to the SSE handler.
- Cancel adapter wired to the DELETE / cancel path.
- `X-Terragon-Test-Replay: 1` header gate added.
- Acceptance: integration harness still green; new tests cover the
  adapter; manual test confirms POST with body triggers a run.

**Wave 3 — Frontend composer adoption.**

- `apps/www/src/components/chat/assistant-ui/composer.tsx` (or equivalent)
  wraps `ComposerPrimitive.Root`. `submitForm` calls
  `runtime.append({ role: "user", content: [...] })`.
- TipTap stays as the input slot inside `Root`. Slash commands, mentions,
  drafts, transcription, attachments preserved.
- `useComposerQueue()` layers the multi-message queue above
  `runtime.append`.
- Acceptance: composer submits via runtime; integration harness green;
  `memo-rerenders.test.tsx` passes; manual smoke on slash commands and
  attachments.

## Test plan

- POST with a valid `RunAgentInput` body triggers a run via `followUp()`
  and then streams. Assert `followUp()` called once with extracted payload.
- POST with an empty body still opens the SSE stream and does not call
  `followUp()`. Backwards compatibility for any caller still treating POST
  as ceremony.
- Two near-simultaneous POSTs for the same thread: first acquires the
  lock and triggers the run; second observes lock contention and returns
  409 without double-calling `followUp()`.
- POST with a `runId` belonging to another user's thread is rejected
  before the lock is acquired (403). Verify no DB writes.
- POST with `X-Terragon-Test-Replay: 1` skips the adapter entirely.
  Replay recordings green without modification.
- Cancel adapter: runtime `cancel()` results in `stopThread()` being
  called with the thread's active runId.
- Failure path: `followUp()` throws → lock released → POST returns 500 →
  thread status not corrupted.
- Composer integration (Wave 3): Send button submits via runtime;
  attachments survive the round-trip; queue absorbs rapid submits.

## References

- Consolidated chat plan: `docs/plans/2026-04-27-refactor-chat-layer-consolidated-plan.md`
- Phase 5 readiness audit: `docs/plans/2026-04-28-phase-5-readiness.md`
- Today's `POST = GET` decision: `apps/www/src/app/api/ag-ui/[threadId]/route.ts:1763`
- Server-action submit pipeline: `apps/www/src/server-actions/follow-up.ts`,
  `apps/www/src/server-lib/follow-up.ts`
- Status enum + `isAgentWorking()` dedup gate: `packages/shared/src/db/thread.ts`

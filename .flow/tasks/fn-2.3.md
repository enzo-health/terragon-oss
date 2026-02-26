# fn-2.3 Build preview UI with explicit unsupported/fallback states

## Description

Ship deterministic preview panel behavior for explicit startup lifecycle states, cookie/iframe fallback, and versioned realtime events.

**Size:** M
**Files:**

- `apps/www/src/components/chat/secondary-panel.tsx`
- `apps/www/src/components/chat/chat-ui.tsx`
- `apps/www/src/components/chat/chat-header-buttons.tsx`
- `apps/www/src/hooks/useRealtime.ts`
- `packages/shared/src/types/preview.ts`

## Approach

- Start previews via explicit `POST /api/internal/preview/session/start` trigger from UI action.
- Use explicit state machine in UI for `preview_session.state` and `unsupportedReason` enums from `packages/shared/src/types/preview.ts`; avoid ad-hoc string checks.
- Render lifecycle transitions deterministically: `pending -> initializing -> ready|unsupported|error`.
- Handle fallback reasons deterministically:
  - `ws_required`
  - `frame_bust`
  - `cookie_blocked`
  - `adapter_unimplemented`
  - `capability_missing`
- Run a preemptive iframe-cookie probe before initial mount; if blocked, show actionable CTA and auto-switch to `new_tab` immediately.
- Use `GET /api/preview/probe/:previewSessionId` for deterministic cookie/frame probe before iframe mount.
- Never mount iframe when capability probe indicates `requiresWebsocket=true` with unsupported proxy WS transport; force `new_tab` before initial render.
- Wire versioned preview events (`v1.preview.*`) with schema checks in realtime hook.
- Validate preview channel subscription tuple (`previewSessionId/threadId/threadChatId/runId`) before accepting stream updates.
- Reconnect policy requires minting a fresh preview subscription token before re-subscribing.
- Keep panel mode deterministic (`diff|preview`) under streaming updates.

## Acceptance

- [ ] UI start action uses the explicit preview start route and respects lifecycle transitions.
- [ ] UI renders enum-driven preview states without ambiguous fallthrough.
- [ ] Cookie probe + runtime cookie-block and frame-bust cases automatically fallback to `new_tab` with clear messaging.
- [ ] `ws_required` is surfaced as an immediate, actionable unsupported state.
- [ ] Iframe mount is gated by capability + unsupported checks (no mount-then-fail for ws-required paths).
- [ ] Unsupported mapping differentiates `adapter_unimplemented` vs `capability_missing`.
- [ ] Reconnect flow always uses a fresh subscription token.
- [ ] Realtime preview events are versioned and parsed with schema guards.

## Test matrix

- E2E: preview start action drives `pending -> initializing -> terminal` state rendering.
- E2E: preemptive cookie probe failure skips iframe and goes straight to `new_tab` fallback.
- E2E: probe endpoint `ws_required`/cookie failure payloads map to immediate fallback states.
- E2E: iframe cookie blocked case triggers `cookie_blocked` fallback.
- E2E: WS-required session opens directly in `new_tab`.
- E2E: reconnect with stale/reused subscription token is rejected until fresh token mint.
- Unit: state reducer handles valid transitions only.

## Done summary

Task completed

## Evidence

- Commits:
- Tests:
- PRs:

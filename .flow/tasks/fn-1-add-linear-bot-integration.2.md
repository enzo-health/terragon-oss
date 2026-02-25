# fn-1-add-linear-bot-integration.2 Webhook route and mention handler

## Description

Create the webhook endpoint and mention handler for Linear Comment.create events. This is the core integration logic: receive webhook → verify signature → detect @mention → resolve user → check feature flag + access tier → fetch issue + attachments → build message → create thread → post acknowledgment.

**Size:** M
**Files:**

- `apps/www/src/app/api/webhooks/linear/route.ts` — new webhook route
- `apps/www/src/app/api/webhooks/linear/handlers.ts` — new mention handler
- `apps/www/src/app/api/webhooks/linear/handlers.test.ts` — handler tests

## Approach

- **Route**: Follow `apps/www/src/app/api/webhooks/slack/route.ts` pattern

  - Attempt `LinearWebhookClient` from `@linear/sdk/webhooks` for signature verification
  - **Fallback**: If SDK webhook client doesn't fit Next.js route handlers, implement manual verification:
    - Header: `Linear-Signature` (hex-encoded HMAC-SHA256)
    - HMAC input: raw request body (UTF-8 string)
    - Secret: `LINEAR_WEBHOOK_SECRET` env var
    - Comparison: `crypto.timingSafeEqual` on hex digest buffers
    - No replay-window check required for v1 (Linear doesn't document one; SDK doesn't enforce one)
  - Return 200 immediately, process via `waitUntil()` from `@vercel/functions`
  - Dispatch on `type === "Comment"` and `action === "create"`

- **Handler**: Follow `apps/www/src/app/api/webhooks/slack/handlers.ts:390-538` pattern
  - **Empty handle guard**: If `LINEAR_MENTION_HANDLE.trim()` is empty, log a warning and skip all processing (no thread creation, no ack/error comment). This prevents matching every comment.
  - **Mention detection**: Use `LINEAR_MENTION_HANDLE` env var (not display name). Regex-escape the input, match case-insensitively. Pattern: `new RegExp(escapeRegex(handle), 'i')`
  - **Self-loop prevention**: Ensure ack comments NEVER contain the mention handle string. No actor.id check needed — this approach avoids blocking the API key owner from being a real user too.
  - **User resolution**: `getLinearAccountForLinearUserId()` with webhook payload's user ID + `organizationId`
  - **Feature flag check**: After resolving user, call `getFeatureFlagForUser(userId, "linearIntegration")`. If disabled, silently ignore (no comment posted).
  - **Access tier check**: Use `getAccessInfoForUser()` to verify billing (match GitHub handler at `handle-app-mention.ts:95`)
  - **Issue fetch**: `linearClient.issue(data.issueId)` then `issue.attachments()` for full context
  - **GitHub repo extraction**: Parse GitHub attachment URLs (`sourceType === "github"`) to auto-detect repo
  - **Message building**: Include issue identifier, title, description, comment body, attachment list, issue URL. Reuse `formatThreadContext()` from `ext-thread-context.ts`
  - **Thread creation**: `newThreadInternal()` with sourceType `"linear-mention"` and all-string metadata
  - **Ack comment**: `linearClient.createComment({ issueId, body })` — body must NOT contain LINEAR_MENTION_HANDLE
  - **Error comments**: If no linked account or no default repo, post setup instructions to Linear (plain text with link to settings, no interactive buttons)

## Key context

- Practice-scout warns: SDK generated types don't match webhook payloads (flat ID strings vs nested objects). Handle `data.issueId` as string, not `data.issue.id`
- Linear retries webhooks at 1min, 1hr, 6hr. v1 accepts rare duplicates (matching existing handlers)
- Comment webhook top-level fields: `action`, `type`, `actor`, `data`, `organizationId`, `webhookId`, `webhookTimestamp`
- Comment `data` includes: `id`, `body`, `createdAt`, `issueId`, `userId` (all as flat strings)
- Rate limit: 5000 req/hr. Set `first: 20` limit on attachment queries
- Must return 200 within 5 seconds (Linear timeout)
- `getFeatureFlagForUser` pattern: see how GitHub handler gates features at `handle-app-mention.ts`

## Acceptance

- [ ] Webhook route at `POST /api/webhooks/linear` accepts and verifies Linear webhook signatures
- [ ] Verification uses `LinearWebhookClient` from SDK, with fallback to manual HMAC-SHA256 if SDK doesn't fit
- [ ] Manual fallback: reads `Linear-Signature` header, computes HMAC-SHA256 of raw body with `LINEAR_WEBHOOK_SECRET`, uses `timingSafeEqual`
- [ ] Invalid signatures return 401; missing LINEAR_WEBHOOK_SECRET in dev → log warning and skip verification
- [ ] Non-Comment or non-create events are ignored with 200 response
- [ ] Empty `LINEAR_MENTION_HANDLE` → log warning and skip processing (no match-all behavior)
- [ ] @mention detected via LINEAR_MENTION_HANDLE (case-insensitive, regex-escaped)
- [ ] Non-mention comments are ignored
- [ ] Self-loop prevented: ack comments never contain the mention handle string
- [ ] Linear user resolved to Terragon user via linearAccount table
- [ ] `linearIntegration` feature flag checked for resolved user; disabled → silently ignore
- [ ] User access tier checked before thread creation (match GitHub pattern)
- [ ] Missing account → error comment posted to Linear with settings link
- [ ] Missing default repo (and no GitHub attachment) → error comment posted to Linear
- [ ] Issue details fetched: identifier, title, description, url, branchName
- [ ] Issue attachments fetched and formatted in message (title, url, sourceType)
- [ ] GitHub repo auto-extracted from attachment URL when sourceType is "github"
- [ ] Thread created via `newThreadInternal()` with sourceType "linear-mention" and all-string metadata
- [ ] Acknowledgment comment posted to Linear with task link (no mention handle in body)
- [ ] Handler tests pass: `pnpm -C apps/www test`
- [ ] Entire flow completes within waitUntil() (non-blocking to webhook response)

## Done summary

Implemented webhook route at POST /api/webhooks/linear with HMAC-SHA256 signature verification (SDK + manual fallback) and mention handler that detects @mentions via LINEAR_MENTION_HANDLE, resolves Linear users to Terragon users, checks feature flags and access tiers, fetches issue details/attachments, auto-extracts GitHub repos from attachments, creates threads via newThreadInternal, and posts acknowledgment comments back to Linear. Includes 12 handler tests.

## Evidence

- Commits: 6fd6442, 768859b
- Tests: pnpm -C apps/www test -- --run src/app/api/webhooks/linear/handlers.test.ts, pnpm tsc-check
- PRs:

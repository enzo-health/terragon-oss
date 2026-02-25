# fn-2-upgrade-linear-integration-to-linear.2 OAuth flow and callback route

## Description

Implement the OAuth 2.0 install flow for the Linear Agent: a server action that generates the authorization URL, and a callback route that exchanges the code for tokens and stores them encrypted in `linearInstallation`. Fix Slack's callback ordering bug. Separate per-user disconnect from workspace uninstall.

**Size:** M
**Files:**

- `apps/www/src/server-actions/linear.ts` — add `getLinearAgentInstallUrl` + `uninstallLinearWorkspace` server actions; clarify `disconnectLinearAccount` is per-user only
- `apps/www/src/app/api/auth/linear/callback/route.ts` — **create** OAuth callback handler

## Approach

- Mirror `getSlackAppInstallUrl` at `apps/www/src/server-actions/slack.ts:37-61`:
  - `userOnlyAction` wrapper
  - Encrypted CSRF state: `{ userId, timestamp, type: "agent_install" }`
  - Auth URL: `https://linear.app/oauth/authorize` with params: `client_id`, `redirect_uri`, `response_type=code`, `scope=read,write,app:assignable,app:mentionable` (comma-separated), `actor=app`, `state`
  - `redirect_uri`: `${nonLocalhostPublicAppUrl()}/api/auth/linear/callback`
- Callback route at `/api/auth/linear/callback` — **CRITICAL: Fix Slack's ordering bug**:
  1. Verify `userId` from session (redirect to notFound if missing)
  2. **Handle `error` param FIRST** (before checking `code`/`state`) — `access_denied` may omit `code` entirely, causing a crash if checked first
  3. Validate `state` exists, then **wrap decrypt + JSON.parse in try/catch** — tampered/invalid state → redirect to `invalid_state` (not a 500)
  4. Validate state contents: userId match, <24h expiry
  5. Validate `code` exists
  6. Exchange code: `POST https://api.linear.app/oauth/token` with `client_id`, `client_secret`, `code`, `redirect_uri`, `grant_type=authorization_code`
  7. Response: `access_token`, `token_type`, `expires_in`, `scope`, optional `refresh_token`
  8. Fetch org info via `LinearClient({ accessToken })` → `client.organization` for `organizationId` and `organizationName`
  9. Call `upsertLinearInstallation()` with encrypted tokens (nullable refresh), `installerUserId = userId`, computed `tokenExpiresAt = new Date(Date.now() + expires_in * 1000)`
  10. Redirect to `/settings/integrations?integration=linear&status=success&code=agent_installed`
- **Installation ownership**: `installerUserId` set to authenticated user at install time. Any authenticated user may install (no role check at install time). `uninstallLinearWorkspace` requires no RBAC for MVP — add a `// TODO: restrict to admin role` comment for future.
- **`disconnectLinearAccount`**: Per-user only — deletes `linearAccount` + `linearSettings` for the current user. Does NOT touch `linearInstallation`. Make semantics explicit in function name/comment.
- **`uninstallLinearWorkspace`**: New server action — calls `deactivateLinearInstallation({ db, organizationId })`. No role check for MVP. Requires UI confirmation (task 5).

## Key context

- Linear OAuth uses `actor=app` which makes the app a first-class workspace participant (mentionable, assignable)
- Unlike Slack, Linear doesn't have separate "bot install" vs "user connect" OAuth flows
- Token exchange response includes `expires_in` (seconds) — compute `tokenExpiresAt = Date.now() + expires_in * 1000`
- `@linear/sdk` `LinearClient` constructor accepts `{ accessToken }` for OAuth-authenticated clients
- **Slack callback bug at `api/auth/slack/callback/route.ts`**: Checks `code/state` before `error`, which can 500 when `access_denied` omits `code`. Fix by handling error first.
- **State validation**: Slack doesn't wrap decrypt in try/catch — tampered state causes unhandled exceptions. Fix with explicit error handling.
- One org can only have one `linearInstallation` (unique `organizationId` index). Re-installing updates tokens via upsert.

## Acceptance

- [ ] `getLinearAgentInstallUrl` server action generates correct OAuth URL with `actor=app`, comma-separated scopes, and encrypted state
- [ ] Callback route handles `error` param BEFORE checking `code`/`state`
- [ ] Callback wraps state decrypt + JSON.parse in try/catch (tampered state → redirect, not 500)
- [ ] Token exchange stores tokens in `linearInstallation` (nullable refresh token supported)
- [ ] `tokenExpiresAt` computed from `expires_in` response field
- [ ] Org info (ID, name) fetched from Linear API after token exchange
- [ ] `installerUserId` set from authenticated user session
- [ ] Error handling: access_denied, invalid_state, expired state, token exchange failure
- [ ] Redirect URLs follow pattern: `/settings/integrations?integration=linear&status=...&code=...`
- [ ] `disconnectLinearAccount` is per-user only (does NOT deactivate `linearInstallation`)
- [ ] `uninstallLinearWorkspace` is a separate action with `// TODO: restrict to admin role` comment
- [ ] Type check passes: `pnpm tsc-check`

## Done summary

Implemented Linear Agent OAuth install flow: added `getLinearAgentInstallUrl` server action with actor=app, encrypted CSRF state, and feature-flag gating; created `/api/auth/linear/callback` route with error-first handling, try/catch state validation, token exchange, org fetch, and encrypted token storage; added `uninstallLinearWorkspace` server action; fixed Slack callback ordering bug (error-first, try/catch state decrypt, type validation).

## Evidence

- Commits: f53f883, 84b4ba5
- Tests: pnpm tsc-check
- PRs:

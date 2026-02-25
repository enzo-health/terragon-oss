# fn-2-upgrade-linear-integration-to-linear.1 Schema, env vars, model layer, and token refresh

## Description

Add the `linearInstallation` table for workspace-level OAuth tokens, new env vars for OAuth client credentials, model layer CRUD, a token refresh utility with DB-level concurrency protection, type exports, redesign `ThreadSourceMetadata` for agent sessions, and a `getThreadByLinearAgentSessionId()` query helper.

**Size:** M
**Files:**

- `packages/shared/src/db/schema.ts` — add `linearInstallation` table after `linearSettings` (L774)
- `packages/shared/src/db/types.ts` — redesign `linear-mention` in `ThreadSourceMetadata`; add `LinearInstallation`/`LinearInstallationInsert` type exports
- `packages/env/src/apps-www.ts` — add `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`; deprecate `LINEAR_API_KEY`, `LINEAR_MENTION_HANDLE`
- `packages/shared/src/model/linear.ts` — add `linearInstallation` CRUD functions
- `packages/shared/src/model/threads.ts` — add `getThreadByLinearAgentSessionId()` helper
- `apps/www/src/server-lib/linear-oauth.ts` — **create** token refresh utility with DB-level CAS guard
- `apps/www/.env.example` — add new env vars
- `packages/shared/src/model/linear.test.ts` — add tests for new model functions

## Approach

- Follow `slackInstallation` table pattern at `packages/shared/src/db/schema.ts:633-659`
- `linearInstallation` columns: `id`, `organizationId` (unique), `organizationName`, `accessTokenEncrypted`, `refreshTokenEncrypted` (**nullable** — some installs may not receive a refresh token), `tokenExpiresAt`, `scope`, `installerUserId` (FK → user), `isActive`, `createdAt`, `updatedAt`
- If `refreshTokenEncrypted` is null and token expires, call `deactivateLinearInstallation()` and surface "reinstall required" state
- Model functions: `upsertLinearInstallation()`, `getLinearInstallationForOrg()`, `deactivateLinearInstallation()`, `updateLinearInstallationTokens()`
- **New model helpers in `packages/shared/src/model/threads.ts`**:
  - `getThreadByLinearAgentSessionId({ db, agentSessionId, organizationId? })` — queries thread table using JSON path on `sourceMetadata` JSONB column: `sql\`${schema.thread.sourceMetadata}->>'agentSessionId' = ${agentSessionId}\``. Optionally scoped by `organizationId`for extra safety (Linear session IDs should be globally unique but scope-guarding is defensive). Used by task 3 for`AgentSessionEvent.prompted` thread lookup.
  - `getThreadByLinearDeliveryId({ db, deliveryId })` — queries `sourceMetadata->>'linearDeliveryId' = ${deliveryId}`. Used by task 3 for idempotency check before thread creation.
- Token refresh utility (`linear-oauth.ts`): accepts `organizationId`, checks `tokenExpiresAt` (refresh proactively 5 min before expiry). Uses **DB-level optimistic CAS** (`UPDATE linearInstallation SET accessTokenEncrypted=..., tokenExpiresAt=... WHERE organizationId=? AND tokenExpiresAt=?oldValue` — 0 rows updated = another instance refreshed it already; re-read and use new token). On `invalid_grant` → call `deactivateLinearInstallation()`.
- **Injectable clock** for testability: `refreshLinearTokenIfNeeded(organizationId, db, opts?: { now?: () => Date })`. Default `now = () => new Date()`. Tests pass a fake clock to control expiry without real delays.
- Env vars: Use `str({ allowEmpty: true, default: "" })` pattern matching existing Linear vars at `apps-www.ts:126-128`
- `LINEAR_API_KEY` and `LINEAR_MENTION_HANDLE`: Keep in env validation but add `// @deprecated` comments
- **Type exports**: Add `LinearInstallation` and `LinearInstallationInsert` to `packages/shared/src/db/types.ts` alongside existing exports
- **ThreadSourceMetadata redesign** for `linear-mention`:
  - `agentSessionId: string` — **required** on new records, the Linear agent session ID
  - `organizationId: string` — required (unchanged)
  - `issueId: string` — required (unchanged)
  - `issueIdentifier: string` — required (unchanged)
  - `issueUrl: string` — required (unchanged)
  - `commentId?: string` — **optional** (agent sessions from delegation/assignment have no comment)
  - `linearDeliveryId?: string` — **new**, webhook delivery ID for idempotency
- **Backward compatibility**: Legacy fn-1 threads have `sourceType = "linear-mention"` but no `agentSessionId` in `sourceMetadata`. The type definition must reflect this: `agentSessionId` is required for new inserts but existing records may lack it. Tasks 3 and 4 MUST guard: `if (!thread.sourceMetadata?.agentSessionId) { log("legacy thread, skipping activity emission"); return; }`. Do NOT enforce required at the DB/runtime level for reads — only for new inserts.

## Key context

- Linear OAuth token endpoint: `POST https://api.linear.app/oauth/token` with `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token`
- Access tokens expire in 24 hours. Must check `tokenExpiresAt` before each API call
- `encryptValue()`/`decryptValue()` from `packages/utils/src/encryption.ts` for token storage
- The `agentSessionId` in `ThreadSourceMetadata` maps a Terragon thread to a Linear agent session for activity emission in task 4
- DB-level CAS prevents race conditions in Vercel serverless (in-memory mutex only protects one instance; multiple concurrent functions can race)
- Refresh token may be null: Linear's OAuth response includes `refresh_token` optionally. Always handle null case.
- `getThreadByLinearAgentSessionId` query hits the `sourceMetadata` JSONB column. Ensure there's no performance concern for the query; an index may be added if lookup is slow.

## Acceptance

- [ ] `linearInstallation` table created with encrypted token columns, nullable `refreshTokenEncrypted`, unique `organizationId` index
- [ ] `LinearInstallation` and `LinearInstallationInsert` types exported from `packages/shared/src/db/types.ts`
- [ ] `ThreadSourceMetadata` for `linear-mention` redesigned: required `agentSessionId` (on new inserts), optional `commentId`, new `linearDeliveryId`
- [ ] `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` added to env validation
- [ ] `LINEAR_API_KEY` and `LINEAR_MENTION_HANDLE` marked `@deprecated` but still functional
- [ ] Model CRUD: `upsertLinearInstallation`, `getLinearInstallationForOrg`, `deactivateLinearInstallation`, `updateLinearInstallationTokens`
- [ ] `getThreadByLinearAgentSessionId()` implemented in `packages/shared/src/model/threads.ts` and tested (with optional `organizationId` scope)
- [ ] `getThreadByLinearDeliveryId()` implemented in `packages/shared/src/model/threads.ts` and tested
- [ ] Token refresh uses DB-level optimistic CAS (not in-memory mutex)
- [ ] Missing refresh token → call `deactivateLinearInstallation()`, surface "reinstall required"
- [ ] Injectable `now` clock param in `refreshLinearTokenIfNeeded` for test isolation
- [ ] `.env.example` updated with `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`
- [ ] Model tests pass: `pnpm -C packages/shared test src/model/linear.test.ts`
- [ ] Type check passes: `pnpm tsc-check`

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:

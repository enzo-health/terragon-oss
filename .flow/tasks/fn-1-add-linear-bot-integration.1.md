# fn-1-add-linear-bot-integration.1 Schema, types, env vars, feature flag, and model layer

## Description

Add the foundation layer for Linear integration: DB schema (2 new tables), type system updates, environment variables, feature flag, npm dependency, and the model CRUD layer with tests.

**Size:** M
**Files:**

- `packages/shared/src/db/schema.ts` — add `linearAccount` and `linearSettings` tables
- `packages/shared/src/db/types.ts` — add `"linear-mention"` to ThreadSource, new ThreadSourceMetadata variant, type exports
- `packages/env/src/apps-www.ts` — add LINEAR_WEBHOOK_SECRET, LINEAR_API_KEY, LINEAR_MENTION_HANDLE
- `packages/shared/src/model/feature-flags-definitions.ts` — add `linearIntegration` flag
- `packages/shared/src/model/linear.ts` — new model layer (CRUD for account + settings)
- `packages/shared/src/model/linear.test.ts` — model layer tests
- `apps/www/package.json` — add `@linear/sdk` dependency

## Approach

- Follow `slackAccount` + `slackSettings` table patterns at `schema.ts:661-717`
- Follow `packages/shared/src/model/slack.ts` for CRUD functions (same structure: get, upsert, delete)
- Include `publishBroadcastUserMessage()` calls after mutations (same as Slack model)
- **`linearAccount`**: 2 unique indexes — `(userId, organizationId)` and `(linearUserId, organizationId)` — matching `slackAccount` pattern
- **`linearSettings`**: 1 unique index — `(userId, organizationId)` ONLY — matching `slackSettings` pattern (user-scoped, not org-global)
- `linearAccount` does NOT need encrypted tokens for v1 (using global API key, not per-user OAuth)
- After schema changes, push with `pnpm -C packages/shared drizzle-kit-push-dev`
- Run `pnpm -C apps/www add @linear/sdk` for the Linear SDK
- Pin `@linear/sdk` to a known-good version (check latest stable)

## Key context

- `ThreadSourceMetadata` is a discriminated union at `types.ts:91-113` — add new variant with ALL STRING types:
  `type: "linear-mention", organizationId: string, issueId: string, issueIdentifier: string, commentId: string, issueUrl: string`
  (Linear uses UUID strings, NOT numbers like GitHub)
- Feature flag pattern: `{ defaultValue: false, description: "..." }` — see existing flags at `feature-flags-definitions.ts:27-133`
- Env var `LINEAR_MENTION_HANDLE` (not "display name") — the exact trigger string for @mentions, case-insensitive
- Env var pattern: `str({ allowEmpty: true, default: "" })` — see Slack section at `apps-www.ts:97-100`
- Model layer must include `deleteLinearSettings()` in addition to the other CRUD functions

## Acceptance

- [ ] `linearAccount` table created with columns: id, userId, linearUserId, linearUserName, linearUserEmail, organizationId, createdAt, updatedAt
- [ ] `linearAccount` has 2 unique indexes: `(userId, organizationId)` and `(linearUserId, organizationId)`
- [ ] `linearSettings` table created with columns: id, userId, organizationId, defaultRepoFullName, defaultModel, createdAt, updatedAt
- [ ] `linearSettings` has 1 unique index: `(userId, organizationId)` only
- [ ] Both tables have proper FK references to user.id with cascade delete
- [ ] `"linear-mention"` added to ThreadSource union type
- [ ] `linear-mention` variant added to ThreadSourceMetadata with ALL STRING types (organizationId, issueId, issueIdentifier, commentId, issueUrl)
- [ ] LinearAccount, LinearAccountInsert, LinearSettings, LinearSettingsInsert types exported
- [ ] 3 env vars defined: LINEAR_WEBHOOK_SECRET, LINEAR_API_KEY, LINEAR_MENTION_HANDLE (with sensible default)
- [ ] `linearIntegration` feature flag defined with defaultValue: false
- [ ] Model functions: getLinearAccountForLinearUserId, getLinearAccounts, upsertLinearAccount, deleteLinearAccount, getLinearSettingsForUserAndOrg, upsertLinearSettings, deleteLinearSettings
- [ ] Model tests pass: `pnpm -C packages/shared test`
- [ ] `@linear/sdk` added to apps/www dependencies (pinned version)
- [ ] Type check passes: `pnpm tsc-check`
- [ ] Schema pushed: `pnpm -C packages/shared drizzle-kit-push-dev`

## Done summary

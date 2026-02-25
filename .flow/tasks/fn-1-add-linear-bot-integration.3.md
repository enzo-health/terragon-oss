# fn-1-add-linear-bot-integration.3 Settings UI for Linear account linking

## Description

Add a "Linear" section to the integrations settings page, gated behind the `linearIntegration` feature flag. Users can link their Linear account, configure a default repository and model, and disconnect (which removes both account and settings records).

**Size:** M
**Files:**

- `apps/www/src/app/(sidebar)/(site-header)/settings/integrations/page.tsx` — add Linear data fetching
- `apps/www/src/components/settings/tab/integrations.tsx` — add Linear section
- `apps/www/src/components/settings/linear/` — new directory for Linear-specific components
- `apps/www/src/server-actions/linear.ts` — server actions for CRUD operations

## Approach

- Follow the Slack integration UI pattern at `apps/www/src/components/settings/tab/integrations.tsx`
- Gate entire section behind `useFeatureFlag("linearIntegration")`
- Use existing `SettingsSection` component wrapper
- **Account linking form**: Input fields for Linear organization ID, user ID, display name, and email. Manual entry only (no per-user API key auto-detect in v1 — the integration uses a single org-level API key from env vars).
- **Default repo selector**: Reuse the existing repo picker component used in Slack settings
- **Default model selector**: Reuse existing model selector component
- **Disconnect button**: Calls server action that deletes BOTH `linearAccount` AND `linearSettings` records in a single transaction
- Server actions call model layer functions from `packages/shared/src/model/linear.ts`
  - Uses `deleteLinearAccount()` and `deleteLinearSettings()` together

## Key context

- Settings integrations page is a server component that fetches data: `page.tsx:1-15`
- Client component renders sections: `integrations.tsx:1-48`
- Slack settings pattern shows how to combine account linking + config in one section
- Must use `publishBroadcastUserMessage()` to notify client of changes (already in model layer from task 1)
- Linear has no workspace-level "installation" flow — simpler than Slack (no OAuth redirect needed for v1)

## Acceptance

- [ ] "Linear" section visible in Settings > Integrations when `linearIntegration` flag is enabled
- [ ] Section hidden when flag is disabled
- [ ] User can enter Linear organization ID, user ID, display name, and email to link account
- [ ] Linked account info displayed after connecting
- [ ] Default repository configurable via repo picker
- [ ] Default model configurable via model selector
- [ ] Disconnect button removes BOTH linearAccount AND linearSettings records (single transaction)
- [ ] UI updates reactively after connect/disconnect (via broadcast message)
- [ ] Type check passes: `pnpm tsc-check`

## Done summary

Added Linear account linking UI to Settings > Integrations page, gated behind linearIntegration feature flag. Users can enter Linear org ID, user ID, display name, and email to connect; configure default repo and model; and disconnect (atomic transaction removing both account and settings records). Server actions enforce feature flag server-side, handle duplicate identity claims with UserFacingError, and use proper ServerActionResult unwrapping. Added 9 new model-layer tests.

## Evidence

- Commits: 8ba3e6cb5d1e3ced3757d6a43b152c12c6edf138
- Tests: pnpm tsc-check, pnpm -C packages/shared test src/model/linear.test.ts
- PRs:

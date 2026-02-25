# fn-2-upgrade-linear-integration-to-linear.5 Settings UI, documentation, and cleanup

## Description

Rewrite the Linear settings UI to use OAuth install button, separate "disconnect account" (per-user) from "uninstall workspace" (workspace-wide), update all documentation for the agent-based flow, and clean up deprecated env vars.

**Size:** M
**Files:**

- `apps/www/src/components/settings/linear/linear-account-settings.tsx` — rewrite: OAuth install button + workspace connection status
- `apps/www/src/components/settings/linear/linear-connect-form.tsx` — remove or replace manual form
- `apps/www/src/components/settings/tab/integrations.tsx` — update Linear section data fetching
- `apps/www/src/app/(sidebar)/(site-header)/settings/integrations/page.tsx` — fetch `linearInstallation` data
- `apps/www/src/server-actions/linear.ts` — separate disconnect actions
- `apps/docs/content/docs/integrations/linear-integration.mdx` — rewrite for agent flow
- `apps/www/.env.example` — update Linear section
- `AGENTS.md` — update with `linearInstallation` table and agent architecture
- `apps/docs/content/docs/resources/release-notes.mdx` — add release notes entry
- `apps/www/src/lib/constants.ts` — bump `RELEASE_NOTES_VERSION`

## Approach

- **Settings UI data contract**: Define `LinearAccountWithSettingsAndInstallation` type for the settings page:

  ```ts
  type LinearAccountWithSettingsAndInstallation = LinearAccountWithSettings & {
    installation: LinearInstallation | null;
  };
  ```

  The page server component (`page.tsx`) fetches `linearAccountsWithSettings` + the single `linearInstallation` for this Terragon org (workspace-level), then joins them: accounts whose `organizationId` matches the active installation get `installation` populated; others get `null`. Pass the combined type to client components.

- **Multi-org scenario**: A Terragon user can have `linearAccount` records for multiple Linear orgs. Only one of those orgs may have an active `linearInstallation` (one Terragon deployment installs to one Linear workspace). The UI shows each account row separately; the workspace install panel is shown once at the top.

- **Settings UI rewrite**:

  - Mirror Slack's OAuth install pattern at `apps/www/src/components/settings/slack.tsx`
  - "Install Linear Agent" button calls `getLinearAgentInstallUrl` server action → redirect to Linear OAuth
  - If `linearInstallation` exists and `isActive`: show workspace name, org ID, connection status, installed date
  - If `linearInstallation` exists but `isActive=false` (e.g., expired/null refresh token): show "Reinstall required" state + "Reinstall" button
  - If `linearInstallation` is null: show "Install Linear Agent" button
  - Keep the existing `linearAccount` manual linking form for user identity mapping (per-user, complementary to workspace install)
  - Keep existing repo picker + model selector (from `linearSettings`)
  - **Separate disconnect semantics**:
    - "Disconnect my account" button: calls `disconnectLinearAccount` → deletes `linearAccount` + `linearSettings` for current user ONLY. Does NOT affect `linearInstallation`. Tooltip: "Removes your personal Linear account link. Other users are unaffected."
    - "Uninstall workspace" button: calls `uninstallLinearWorkspace` → shows confirmation dialog: "This will disable the Linear agent for all users in this workspace. Individual account links remain intact." On confirm → deactivates `linearInstallation`.

- **Server actions** (`server-actions/linear.ts`):

  - Keep `disconnectLinearAccount` for per-user disconnect (deletes account + settings, NOT installation)
  - `uninstallLinearWorkspace` (added in task 2) is already available — wire up to confirmation dialog
  - Add clear JSDoc comment distinguishing the two actions

- **Documentation** (`linear-integration.mdx`):

  - Rewrite setup steps for agent flow: register Linear app → configure OAuth credentials → install via Settings → test mention
  - Update "How It Works" to describe agent sessions and activities
  - Remove references to `LINEAR_API_KEY` and `LINEAR_MENTION_HANDLE`
  - Add Linear app registration instructions (linear.app/settings/api/applications)

- **Env vars cleanup**:

  - `.env.example`: Add `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`. Move `LINEAR_API_KEY` and `LINEAR_MENTION_HANDLE` to a `# Deprecated` comment block
  - `AGENTS.md`: Add `linearInstallation` to Database Schema section, update Recent Features

- **Release notes**: Follow template at `apps/docs/RELEASE_NOTES_TEMPLATE.md`. Early-access format. Bump `RELEASE_NOTES_VERSION` by 1.

## Key context

- Settings integrations page is a server component: `page.tsx` fetches data, passes to client `integrations.tsx`
- The manual `linearAccount` form stays for user identity mapping — workspace OAuth is complementary, not a replacement
- Slack settings at `apps/www/src/components/settings/slack.tsx` is the template for OAuth install button
- **Disconnect vs Uninstall**: Slack doesn't have this problem because Slack disconnect doesn't affect workspace install. Linear Agent uninstall is workspace-wide because there's one installation per org. Must separate the actions or users will accidentally disconnect everyone.
- Per CLAUDE.md: always bump `RELEASE_NOTES_VERSION` after adding release notes entries

## Acceptance

- [ ] "Install Linear Agent" OAuth button visible in Settings when `linearIntegration` flag is enabled
- [ ] Connected workspace shows name, org ID, status, installed date
- [ ] "Reinstall required" state shown when installation is inactive (expired refresh token)
- [ ] Manual account linking form still available for user identity
- [ ] "Disconnect my account" removes user's account + settings only (NOT workspace installation)
- [ ] "Uninstall workspace" shows confirmation dialog with workspace-wide impact warning before deactivating
- [ ] `LinearAccountWithSettingsAndInstallation` type defined and used in page data fetching
- [ ] Multi-org accounts correctly show `installation: null` when no active install matches their org
- [ ] `linear-integration.mdx` rewritten for agent-based flow, no references to deprecated env vars
- [ ] `.env.example` updated with `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`; deprecated vars in comment block
- [ ] `AGENTS.md` updated with `linearInstallation` table and agent architecture description
- [ ] Release notes entry added (early-access format)
- [ ] `RELEASE_NOTES_VERSION` bumped by 1
- [ ] Type check passes: `pnpm tsc-check`

## Done summary

Rewrote Linear settings UI with OAuth install button, workspace panel, and separate "disconnect account" vs "uninstall workspace" actions (with confirmation dialog and installer-or-admin guard). Added LinearInstallationPublic type (strips token fields for safe RSC→client serialization), getLinearInstallation() model function, updated docs for agent-based flow, added release notes entry, bumped RELEASE_NOTES_VERSION to 20, and updated AGENTS.md and .env.example.

## Evidence

- Commits: e59e96e, c27c592, aa00f56
- Tests: pnpm tsc-check, pnpm -C apps/www test src/server-actions/linear.test.ts
- PRs:

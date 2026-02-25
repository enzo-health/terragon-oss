# fn-1-add-linear-bot-integration.4 Documentation and release notes

## Description

Update documentation across the project for the new Linear integration: env example, AGENTS.md, new integration guide, sidebar navigation, release notes, and early-access features list.

**Size:** S
**Files:**

- `apps/www/.env.example` — add LINEAR_WEBHOOK_SECRET, LINEAR_API_KEY, LINEAR_MENTION_HANDLE
- `AGENTS.md` — add Linear to Database Schema and Recent Features sections
- `apps/docs/content/docs/integrations/linear-integration.mdx` — new integration guide
- `apps/docs/content/docs/meta.json` — add Linear to sidebar navigation
- `apps/docs/content/docs/resources/release-notes.mdx` — add release notes entry
- `apps/docs/content/docs/resources/early-access-features.mdx` — add Linear to early-access list
- `apps/www/src/lib/constants.ts` — bump RELEASE_NOTES_VERSION

## Approach

- `.env.example`: Follow pattern of `GITHUB_WEBHOOK_SECRET=***` with inline comments
- `AGENTS.md`: Add to "Database Schema" section and "Recent Features" section (bottom of file)
- Integration guide: Mirror `apps/docs/content/docs/integrations/slack-integration.mdx` structure exactly — same frontmatter, `Steps`/`Step` fumadocs components, `Callout` pointing to settings URL
- Release notes: Follow template at `apps/docs/RELEASE_NOTES_TEMPLATE.md`. Use early-access format since feature-flagged
- Bump `RELEASE_NOTES_VERSION` by 1 (per AGENTS.md instructions)

## Key context

- Slack integration doc is the structural template: `apps/docs/content/docs/integrations/slack-integration.mdx`
- Release notes template: `apps/docs/RELEASE_NOTES_TEMPLATE.md`
- Constants file with RELEASE_NOTES_VERSION: `apps/www/src/lib/constants.ts`

## Acceptance

- [ ] `.env.example` contains LINEAR_WEBHOOK_SECRET, LINEAR_API_KEY, LINEAR_MENTION_HANDLE with comments
- [ ] `AGENTS.md` lists Linear tables in Database Schema section
- [ ] `AGENTS.md` lists Linear integration in Recent Features section
- [ ] `linear-integration.mdx` created with setup steps, configuration, and usage guide
- [ ] `meta.json` includes linear-integration in sidebar navigation under integrations
- [ ] Release notes entry added with early-access format
- [ ] Early-access features list includes Linear integration
- [ ] `RELEASE_NOTES_VERSION` bumped by 1
- [ ] Docs build successfully (no broken links or frontmatter errors)

## Done summary

## Evidence

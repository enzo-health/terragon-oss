# Tri-lens polish pass — impeccable · ui · hallmark

**Date:** 2026-06-04 · **Method:** a 73-agent workflow ran three design skills as lenses over 12 surfaces (3 critics → synthesize plan → implement safe edits → review), then a cross-surface synthesis. Shared layer (`ui/**`, `globals.css`, `layout.tsx`, `shared/**`) was off-limits to implementers and is captured as a backlog below.

**Result:** 69 safe, component-local edits across 63 files. 10/12 surfaces verified clean; 2 needs-fix caught by review and resolved (rate-limit chip behavior-change reverted; automations `var()` fix). Gates: `tsc-check` 17/17 ✓ · `prettier --check` ✓ · `biome lint` ✓.

## What landed

- One-signal-per-interaction subtraction across the app: removed competing hover/press/scale signals (dashboard rows' active:scale, send buttons' box-shadow/scale/opacity lists, chat action hover:opacity-70, FAB's five transition channels) so each interaction has a single legible payoff.
- Motion unified onto the --duration-quick/--ease-standard token scale for chat tool/reasoning chevrons + panels (now finish on one clock), git-diff chevrons, chat-header links, and boot-checklist — replacing off-scale duration-150/200 literals.
- Killed genuinely broken/dead styling: the dashboard suggested-task hover used --sunken (same tone as its dividers, so hover was invisible) now reads as a raised bg-card plate; admin/users-list replaced dead text-mid-text/text-strong-text and unregistered var(--card-cream)/var(--error) bracket literals with registered utilities.
- AA contrast pass: tinted status text moved to \*-strong variants on /10 tints across credentials ConnectionStatusPill, admin role/banned/shadow-ban pills + banner preview, Linear/Slack badges, and settings.
- Fixed broken plurals and restored numeric stability: stats tooltips/summary no longer show '1 threads'/'1 PRs' and route through tabular-nums + toLocaleString grouping; tabular-nums added to digit-bearing fields across thread-list, git-diff stats, settings IDs/dates, and credentials emails so values stop reflowing.
- Copy de-genericized and made product-shaped: thread/dashboard placeholders now lead with the action ('Describe a task — @ to reference files, / for commands'), empty states unified to present-tense, section labels sentence-cased, and unicode ellipsis/apostrophe applied throughout.
- Removed redundant concurrent state signals: dashboard's pulsing coral dot (avatar Loader2->Check already carries it), creating-indicator's animate-ping halo (progress bar carries motion), and the skip-archive toast (ArchiveIcon flip is self-evident).

## Per-surface

- **Dashboard / new-task home** — 9 edits · review: clean
- **Chat transcript (core rendering)** — 5 edits · review: needs-fix
- **Chat layout, panels & diff views** — 7 edits · review: clean
- **Promptbox / composer** — 8 edits · review: clean
- **App shell & sidebar** — 7 edits · review: clean
- **Settings** — 5 edits · review: clean
- **Environments** — 7 edits · review: clean
- **Automations** — 6 edits · review: needs-fix
- **Auth, login, onboarding & marketing** — 4 edits · review: clean
- **Credentials & integrations** — 3 edits · review: clean
- **Stats & data visualization** — 3 edits · review: clean
- **Admin / internal tooling** — 5 edits · review: clean

## Shared-layer backlog (deferred — needs `ui/**` / `globals.css` / `lib/**`)

These were reported by surface implementers but intentionally not applied (the shared layer was off-limits, and PR #259 just touched tokens/atoms). Each is a follow-up.

- **ui/button.tsx — base transition + press feel** — Migrate the Button atom base from raw duration-150 + browser-default easing to duration-[var(--duration-quick)] ease-[var(--ease-emphasis)], and add a borderless icon-toggle size/variant with no press-scale (active:scale-100) for overlaid affordances like secret-reveal eye toggles. Optionally add a tuned login-CTA press timing via duration-[var(--duration-instant)].
  - _why:_ Every consumer currently re-declares per-leaf motion or hand-neutralizes the inherited active:scale; one signature in the atom removes the duplication and the scale-fighting overrides. · _surfaces:_ promptbox, auth-onboarding, credentials, settings, dashboard
- **Shared save-feedback through useUpdateUserSettingsMutation (atoms/user.ts)** — Route the shared mutation through one onSuccess toast.success("Settings saved") + onError toast.error("Couldn't save your settings. Try again."); drop bespoke per-control toasts (notification-settings.tsx) and reconsider silent-success vs toast policy for env/MCP/setup-script saves.
  - _why:_ Auto-save controls across Settings and Environments give inconsistent (or no) save feedback; centralizing it in the mutation hook makes the philosophy one decision instead of per-call drift. · _surfaces:_ settings, environments
- **ConnectionStatusPill via ui/badge.tsx** — Route ConnectionStatusPill through a Badge variant (success / quiet outline) so it inherits the AA text ramp and type scale, and move the not-connected state onto a \*-strong token for AA. Confirm it stays the canonical chip the Slack/Linear/admin badges mirror.
  - _why:_ The pill is hand-rolled in credentials/ while Slack, Linear, and admin badges were aligned to its treatment this pass; making it a real Badge variant locks the convention in one place. · _surfaces:_ credentials, settings
- **Coral primary 'New task' CTA for empty states** — Add a coral primary Button + lucide SquarePen linking to /dashboard to empty.tsx and the sidebar empty state, mirroring app-sidebar.tsx:131, so empty states activate rather than narrate.
  - _why:_ Empty-state copy was unified this pass but the states still only describe; a CTA needs the shared Button atom and primary styling that were out of bounds. · _surfaces:_ sidebar
- **ui/chart.tsx — zero-value tooltip guard** — Change the default tooltip value guard from `{item.value && (...)}` to `item.value != null` so legitimate 0 counts render a number.
  - _why:_ Stats safely removed custom tooltip formatters and now relies on the shared default tooltip, but stats days are frequently 0 and the truthy guard suppresses them. · _surfaces:_ stats
- **ui/popover.tsx — token-driven resize seam** — Add a fixed-width/transform-based enter seam (scaleX/opacity on --duration-quick) to PopoverContent so the add-context popover can animate its content-swap resize instead of resizing instantly.
  - _why:_ Avoiding the layout-animating width meant dropping the transition entirely; a proper seam needs atom support. · _surfaces:_ promptbox
- **isOptimisticThread(id) helper + shared optimistic-row class set (lib/utils)** — Extract isOptimisticThread(id) and one shared pending-row class set to replace inlined thread.id.startsWith('optimistic-') checks across item.tsx, section.tsx, sidebar-thread-list.tsx, presenting pending threads identically.
  - _why:_ Dashboard (staggered slide-in) and sidebar (flat opacity-60) present pending threads differently and the string-literal check is duplicated and de-sync-prone. · _surfaces:_ sidebar, dashboard
- **Shared Skeleton vocabulary (ui/skeleton.tsx)** — Replace the LoaderCircle spinner in thread-list/contents.tsx with a list-shaped skeleton and reconcile raw animate-pulse implementations onto the Skeleton atom so dashboard panel, sidebar, and Suspense fallback share one pulse.
  - _why:_ Loading states use three different vocabularies (spinner, raw animate-pulse, ad-hoc skeleton); one atom unifies them. · _surfaces:_ sidebar, dashboard, stats
- **Tool-icon differentiation in native-thread (NativeToolGroup/NativeToolCall)** — Map toolName to differentiated lucide icons (FileText read/edit, TerminalSquare bash, Search grep/glob, Globe web, Wrench fallback) instead of a hardcoded Wrench per row.
  - _why:_ Every tool row currently shows the same Wrench; differentiation intersects the icon-set standardization convention and should land with the icon-set review. · _surfaces:_ chat-transcript
- **native-thread-utils.ts adapter labels + reasoning timer** — hasError statusLabel "Needs attention"->"Failed"; derive reasoning label via getReasoningTitle()/stripLeadingReasoningTitle() instead of hardcoded "Thinking"; port reasoning-block.tsx's live elapsed (Ns) tabular-nums counter onto the NativeReasoning leaf.
  - _why:_ These were skipped because native-thread-utils.ts was outside the chat-transcript surface's allowed files and/or marked medium-risk; they belong to the adapter owner. · _surfaces:_ chat-transcript
- **Body-text scale + numeric formatting unification** — Pick one body scale across native-thread MessageContent, text-part.tsx plain branch, and ai/message.tsx MessageText (currently text-sm/6.5 vs text-sm leading-relaxed vs fluid-base leading-relaxed). Separately, strip trailing .0 in usage-chip formatTokens and toLocaleString() the three raw tooltip integers.
  - _why:_ Three disagreeing body sizes cause rhythm drift when markdown first appears mid-message; touches the fluid-base typography contract. Number formatting fell below the per-surface edit cap. · _surfaces:_ chat-transcript
- **Off-scope dead-token / unregistered-bracket-var sweep** — Apply the same registered-utility swaps used in github.tsx/users-list.tsx to the sibling files still carrying dead tokens or var() bracket literals: slack.tsx, slack-installations.tsx:84, r2-tree-view.tsx:276/299, environment-content.tsx:92/95, github-pr-content.tsx:35, user-search.tsx.
  - _why:_ These share the exact pattern fixed this pass but were outside assigned file lists; a follow-up sweep finishes the token cleanup. · _surfaces:_ admin
- **SettingsSection spacing rhythm + FormMessage/status-dot tokens** — Collapse SettingsSection's double space-y-6 to a single owner and bump the label/description gap-0.5 (2px, off-grid) to gap-1; give ui/form.tsx FormMessage a reserved min-h-[1lh] slot; raise the disabled status-dot in automations/item.tsx off bg-neutral onto a mid/muted-foreground token.
  - _why:_ Spacing is double-coupled and off-grid; FormMessage pops in and shifts dialogs; the disabled status dot nearly disappears on bg-card. All need shared atoms or globals.css token decisions. · _surfaces:_ settings, automations
- **Out-of-surface copy/CTA cleanups** — In useTypewriter.ts replace example-prompt trailing ... with … and rewrite the two cliche/dangling lines into concrete product prompts; standardize … across admin inputs/loading labels via the shared EntityIdInput; route feature-flags.tsx + admin destructive actions through the shared AlertDialog with type-to-confirm on bulk wipe; swap the native snapshot-size <select> and the 'Multiple times per day' native checkbox for the shadcn Select/Checkbox primitives.
  - _why:_ First-run typewriter copy is the first thing a new user reads; native confirm()/select/checkbox controls skip token styling and the focus ring. All blocked by ui/**, lib/**, or out-of-surface files. · _surfaces:_ dashboard, admin, environments, automations

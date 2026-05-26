# Mobile Responsiveness Audit Plan — apps/www

Date: 2026-05-25 App: `apps/www` (Next.js 16, React 19, Tailwind v4) Goal: find everywhere the app breaks, cramps, or feels wrong on a phone, ranked by how much it hurts, with a concrete fix for each.

## What's already true (so we don't re-audit it)

The app is **partially** responsive, switched by JavaScript rather than CSS:

- `usePlatform()` (`src/hooks/use-platform.ts`) reads `window.innerWidth` against a 768px breakpoint and returns `"unknown" | "mobile" | "desktop"`. It's `"unknown"` until after mount.
- The sidebar collapses to a `Sheet` drawer; the artifact/secondary panel swaps to `MobileArtifactDrawer`; there are `sheet-or-menu` and `responsive-combobox` primitives and a `chat-header-share-drawer`.
- Tailwind responsive prefixes are used unevenly: ~102 `sm:`, ~49 `md:`, ~20 `lg:` across the whole app — light coverage for an app this size.

So the audit is about finding the gaps in a half-built mobile story, not building one from scratch.

## The one architectural question that shapes everything

`usePlatform()` **switches layout in JS, after hydration.** Consequences to confirm or rule out:

- First paint renders with platform `"unknown"` → does a platform-branched surface render the wrong layout (or nothing) before the effect runs? Expect a flash / layout shift on the chat view and sidebar.
- Because the choice depends on `window.innerWidth`, the server can't pre-pick it — everything platform-gated is effectively client-only.
- A CSS-first approach (Tailwind `md:` breakpoints, container queries) renders correctly on the server with no flash.

**Decided (2026-05-25): migrate the big surfaces off `usePlatform` to CSS-first breakpoints.** This is a goal of the audit, not just a recommendation. Workstream W4 below owns it. Keep `usePlatform` only where a genuine behavioural fork (not just layout) needs the JS value.

## Audit workstreams

### W1 — Static code inventory (no running app needed)

Sweep the codebase for the mechanical causes of mobile breakage and record each as a finding with `file:line`. Targets:

| Risk                   | What to grep / inspect                                               | Why it breaks mobile                                                 |
| ---------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Horizontal overflow    | 56 `w-[..px]`, 71 `min-w-*`, 13 `whitespace-nowrap`                  | Fixed/min widths wider than 375px push the whole page sideways       |
| Wide data              | 9 `<table>`/`<Table>` (settings, admin, environments)                | Tables rarely reflow; need scroll-in-container or card layout        |
| Scroll containment     | 8 `overflow-x` containers, code blocks, `diff-part`, terminal output | Wide content must scroll _inside_ its box, not blow out the viewport |
| Viewport height        | `min-h-svh`/`h-screen` usage (only ~8)                               | `100vh`/`h-screen` is wrong on mobile (URL bar); must be `svh`/`dvh` |
| Touch targets          | icon buttons, chat toolbar, header actions                           | < 44px tap targets are hard to hit                                   |
| Safe-area insets       | fixed/bottom elements (promptbox, scroll-to-bottom FAB)              | Notch/home-indicator overlap without `env(safe-area-inset-*)`        |
| Hover-only affordances | `hover:` reveals with no tap equivalent                              | Touch has no hover; hidden actions become unreachable                |

Output: a per-surface findings table.

### W2 — Live device-matrix walkthrough (needs a running app)

**Deferred this pass (decided 2026-05-25).** This worktree has no dev env (no `.env`, packages need building), so we audit statically (W1 + W3 + W4 by code-reading) now and run the live device walkthrough later. When we do: drive the real app at phone sizes with the `chrome-devtools` MCP (`emulate`, `resize_page`, `take_screenshot`, `lighthouse_audit`) and screenshot each critical flow.

Device matrix (approved):

| Device                | Logical width | Why                                              |
| --------------------- | ------------- | ------------------------------------------------ |
| iPhone SE             | 375px         | Smallest mainstream width — the stress test      |
| iPhone 15/Pro         | 393px         | Most common iOS, has the notch/Dynamic Island    |
| Pixel 8               | 412px         | Common Android, Chrome URL-bar behaviour         |
| Small tablet portrait | 768px         | The exact breakpoint boundary — check both sides |

Flows to walk per device (priority order below).

### W3 — Input & keyboard behaviour (the promptbox)

The TipTap promptbox has **no** mobile-specific handling today (no `inputMode`, `enterKeyHint`, VisualViewport, or keyboard-aware layout). Audit specifically:

- Does the on-screen keyboard cover the composer / send button? (VisualViewport handling)
- Enter behaviour on mobile (newline vs send) and the send button's reachability.
- Slash commands, mentions, and image attach on touch.
- Does the scroll area resize when the keyboard opens, or does content hide behind it?

### W4 — Migrate big surfaces from `usePlatform` to CSS-first breakpoints

Per the decision above. For each platform-branched surface, replace the JS fork with CSS where the difference is purely layout:

- **Inventory** every `usePlatform()` / `usePlatform() === "mobile"` consumer (`sidebar.tsx`, `secondary-panel.tsx`, `chat-header-buttons.tsx`, `send-button.tsx`, `thread-menu-dropdown.tsx`, `sheet-or-menu.tsx`, `responsive-combobox.tsx`).
- For each, decide: **layout-only** (→ Tailwind `md:` breakpoint or container query, delete the JS branch) vs **behavioural fork** (e.g. drawer-vs-split-pane that needs different components/state → keep `usePlatform`, but make it SSR-safe so first paint isn't wrong).
- Where two component trees must coexist (drawer vs panel), render both and toggle with `hidden md:block` / `md:hidden` so the server picks correctly and there's no post-hydration flash — or gate behind a CSS container query.
- Re-test each converted surface in the W1 sweep (overflow, touch targets).

This is the highest-leverage structural fix: it removes the hydration flash, lets the server render the right layout, and deletes JS branches.

## Surface priority

Audit in this order — the chat experience is the product:

1. **Thread / chat view** (`chat-ui-layout.tsx`, `chat-messages.tsx`) — messages, streaming, code blocks, diffs, terminal, the secondary-panel drawer.

2. **Promptbox** (`src/components/promptbox/`) — W3.

3. **Dashboard / task list** — the landing surface after login.

4. **Settings, Environments, Admin** — the table-heavy surfaces (overflow suspects).

5. **Login / onboarding** — first impression.

## Deliverable

A findings doc (`docs/plans/2026-05-25-mobile-responsiveness-findings.md`) with each issue as: surface, `file:line`, severity (Critical = unusable / Major = painful / Minor = polish), screenshot if from W2, and a concrete fix. Then a fix plan grouped so related changes land together.

## Decisions (resolved 2026-05-25)

1. {==**Scope** — audit-only (findings doc), or audit **and** fix in the same pass?==}{>><<}{id="c1" by="user" at="2026-05-25T19:26:33.806Z"} {>>Resolved: audit **and** fix together. I produce the findings doc and implement fixes (including the W4 CSS-first migration) in the same pass.<<}{id="r1" by="AI" at="2026-05-25T19:30:00.000Z" re="c1"}

2. {==**Live testing** — stand up the dev env so I can run W2 against the real app, or keep this pass static (W1 + W3 by code reading) and defer device screenshots?==}{>><<}{id="c2" by="user" at="2026-05-25T19:26:43.756Z"} {>>Resolved: static this pass (W1 + W3 + W4 by code-reading). W2 device screenshots deferred until a dev env is available.<<}{id="r2" by="AI" at="2026-05-25T19:30:00.000Z" re="c2"}

3. {==**The** `usePlatform` **question** — in scope to recommend moving big surfaces to CSS-first breakpoints, or treat layout architecture as out of bounds and only fix within the current JS-switching approach?==}{>>move to css fiurst breakpoints<<}{id="c3" by="user" at="2026-05-25T19:27:08.606Z"} {>>Resolved: yes — see workstream W4. Layout-only forks move to CSS; genuine behavioural forks stay on `usePlatform` but made SSR-safe.<<}{id="r3" by="AI" at="2026-05-25T19:30:00.000Z" re="c3"}

4. {==**Targets** — is the device matrix above right, or are there specific phones/customers to prioritise?==}{>>looks pretty good<<}{id="c4" by="user" at="2026-05-25T19:27:27.731Z"} {>>Resolved: matrix approved as-is.<<}{id="r4" by="AI" at="2026-05-25T19:30:00.000Z" re="c4"}

## Execution order

1. **W1** static inventory → findings doc (`docs/plans/2026-05-25-mobile-responsiveness-findings.md`).
2. **W4** CSS-first migration of platform-branched surfaces.
3. **W3** promptbox keyboard/input fixes.
4. Re-sweep converted surfaces; verify with `tsc-check` + biome before opening a PR.

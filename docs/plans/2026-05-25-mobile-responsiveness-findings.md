# Mobile Responsiveness Findings — apps/www

Date: 2026-05-25
Method: W1 static inventory (4 parallel auditors) + W3 promptbox review + W4 `usePlatform` inventory. Live device testing (W2) deferred per decision.
Target: 375px (iPhone SE) → 768px.

## Already handled (verified, no action)

- Shared `Table` primitive wraps tables in `overflow-x-auto`; admin/settings tables scroll instead of widening the page.
- Safe-area insets applied globally on `<body>`; login shell uses `100dvh`.
- Enter-inserts-newline on touch is correct (`use-promptbox.tsx:366-368`); `autofocus: !isTouchDevice` avoids keyboard pop.
- `send-button` label has an SSR `isMounted` guard (changes once, no flash).

## Findings

Severity: **Critical** = unusable on phone · **Major** = painful · **Minor** = polish.

### Real bugs (not strictly mobile)

| #   | file:line                                                            | Sev   | Issue                                                                                                                                                                 | Fix                                                                                  |
| --- | -------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `promptbox/simple-promptbox.tsx:213`, `add-context-button.tsx:68,85` | Major | `hidden xs:flex` / `xs:hidden` — `xs` is not a defined Tailwind v4 breakpoint here, so the inline file-attach button is hidden on **every** viewport (incl. desktop). | Define `--breakpoint-xs: 30rem` in the `@theme` block of `globals.css` (single fix). |
| 2   | `environments/environment-variables-editor.tsx:315`                  | Major | Import dialog `max-w-2xl` replaces `DialogContent`'s base `max-w-[calc(100%-2rem)]` cap → overflows on all phones; `max-h-[90vh]` is static.                          | `sm:max-w-2xl` + `max-h-[90dvh]`.                                                    |

### Layout / overflow

| #   | file:line                                          | Sev   | Issue                                                                                                                                                                 | Fix                                                                                 |
| --- | -------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 3   | `chat/chat-ui-layout.tsx:142`                      | Major | Runtime column `flex-1 ... overflow-hidden` lacks `min-w-0` → wide code/terminal/diff forces page-level horizontal overflow (classic flex blowout).                   | Add `min-w-0`.                                                                      |
| 4   | `chat/chat-prompt-box.tsx` + `globals.css:510-522` | Major | Composer safe-area padding only applies under `@media (display-mode: standalone)` (PWA). In plain mobile Safari/Chrome the composer collides with the home indicator. | Apply `padding-bottom: calc(0.5rem + env(safe-area-inset-bottom))` unconditionally. |
| 5   | `chat/secondary-panel-shell.tsx:227`               | Minor | Artifact tablist is a horizontal flex with no `overflow-x-auto`; 3+ artifacts overflow the drawer at 375px.                                                           | Add `overflow-x-auto min-w-0`.                                                      |
| 6   | `chat/terminal-panel.tsx:33`                       | Minor | `max-h-[80vh]` (static vh) + no bottom safe-area on the overlay.                                                                                                      | `max-h-[80dvh]` + `pb-[env(safe-area-inset-bottom)]`.                               |
| 7   | `environment-variables-editor.tsx:235,252`         | Minor | Key/value inputs `flex-row` at all widths → cramped at 375px.                                                                                                         | `flex-col sm:flex-row`.                                                             |
| 8   | `ui/popover.tsx:33`                                | Minor | `w-72` + wide consumer overrides can reach the viewport edge.                                                                                                         | Add `max-w-[calc(100vw-1rem)]` to base.                                             |

### Touch / hover

| #   | file:line                                                         | Sev   | Issue                                                                                    | Fix                                                                                                                |
| --- | ----------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 9   | `ai-elements/markdown-renderer.tsx:242`, `chat/bash-tool.tsx:134` | Major | Copy buttons are `opacity-0 group-hover:` with no touch fallback → unreachable on touch. | Add `[@media(hover:none)]:opacity-70` (pattern already in `chat-message-toolbar.tsx:99`).                          |
| 10  | `ui/button.tsx:23-29`, `ui/dropdown-menu.tsx:77`                  | Major | All button sizes < 44px (`h-8`/`h-7`/`size-8` = 28–32px); menu rows ~30px.               | Add a coarse-pointer touch floor (`@media (pointer: coarse)` min-h/min-w ≥ 44px) without changing desktop visuals. |
| 11  | `promptbox/send-button.tsx`, `speech-to-text-button.tsx`          | Minor | 32px composer controls packed into 375px.                                                | Folds into #10's coarse-pointer floor.                                                                             |

### Viewport units

| #   | file:line                                                                              | Sev   | Issue                                                                                | Fix          |
| --- | -------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------ | ------------ |
| 12  | `app/error.tsx:20`, `cli/main.tsx:58,89,105,137`, `credentials/claude-redirect.tsx:75` | Minor | `min-h-screen` (static `100vh`) on full-screen shells → mobile-chrome overflow/jump. | `min-h-svh`. |

### W3 — Promptbox input

| #   | file:line                                                                                            | Sev   | Issue                                                                                                                                | Fix                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 13  | `promptbox/use-promptbox.tsx:359-363`                                                                | Major | Editable has no `inputMode`/`enterKeyHint`/`autocapitalize`/`autocorrect` → poor mobile typing, wrong capitalization for code/paths. | Add `enterKeyHint: "enter"`, `autocapitalize: "off"`, `autocorrect: "off"`, `spellcheck: "true"` to `editorProps.attributes`. |
| 14  | `promptbox/use-promptbox.tsx:222-230,305-313` + `mention-list.tsx:242`, `slash-command-list.tsx:153` | Major | Mention/slash tippy popovers (`min-w-[300px]`/`[250px]`) have no `maxWidth`/`preventOverflow`/`flip` → overflow at 375px.            | `maxWidth: "calc(100vw - 16px)"` + popper `preventOverflow`/`flip`; `min-w-[min(300px,90vw)]`.                                |

### W4 — Platform forks (CSS-first migration)

| #   | file:line                                  | Sev   | Issue                                                                                                                                            | Fix                                                                                                                                                                                                  |
| --- | ------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15  | `chat/chat-header-buttons.tsx:51,77,93,97` | Major | Button visibility forks on JS `useIsSmallScreen()` → desktop button set flashes on mobile first paint. **Layout-only** parts are CSS-migratable. | ShareButton/CodeButton → `hidden sm:flex`; paired panel icons → `PanelBottom sm:hidden` + `PanelRight hidden sm:block`. Keep JS only for `aria-haspopup` + menu-visibility tied to drawer behaviour. |

## Deferred — need live device verification (W2)

These are the two highest-impact structural changes, but both are behavioural and risky to land without a real device (W2 was deferred). Documented here as the recommended next pass:

- **A. Seed `usePlatform` from a server-readable cookie.** Today `"unknown"`→desktop, so real phones render the desktop tree on first paint, then swap. Worst-flash surfaces: `secondary-panel.tsx:184` (whole-tree drawer↔split-pane flip), `ui/sidebar.tsx:71` (Sheet absent from SSR; trigger inert until hydration). Fix: write a viewport/UA-derived cookie, seed the platform server-side so first paint matches the device. Touches SSR + many consumers → verify on devices.
- **B. VisualViewport keyboard handling for the composer.** No `VisualViewport`/`dvh` keyboard logic exists. `interactiveWidget: "resizes-content"` covers Android Chrome + iOS 26+, but **older iOS Safari overlays the keyboard over the composer/send**. Fix: subscribe to `window.visualViewport` resize → CSS var → composer offset. Needs device testing to tune.

## This pass implements

Findings 1–14 + 15 (the layout-only chat-header migration). Deferred items A and B are left for a device-backed pass. Verification: `tsc-check` + biome; no live device pass.

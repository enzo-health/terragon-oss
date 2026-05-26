# Truly Responsive Architecture — apps/www (research-backed)

Date: 2026-05-25
Why this doc: touch-target bumps and `sm:` overrides made the app _less broken_ on phones, but they're still viewport-breakpoint patches. This is the architecture to make it genuinely responsive, grounded in 2026 best practices.

## What the research says

1. **Container queries for components, media queries for page layout.** Components should adapt to the width of _their container_, not the viewport. Baseline since 2023, ~93% support, built into Tailwind v4 (`@container`, `@sm`/`@md`, `@min-*`/`@max-*`, `cqw` units — no plugin). Sources: [freeCodeCamp](https://www.freecodecamp.org/news/media-queries-vs-container-queries/), [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Container_queries).
2. **JS device detection is an anti-pattern.** `useMediaQuery`/`usePlatform` return the wrong value during SSR → hydration mismatch, and are reactive not declarative. Use CSS for styling; reserve JS only for genuine behavioral forks. Source: [OneUptime](https://oneuptime.com/blog/post/2026-01-24-fix-hydration-mismatch-errors-nextjs/view), [MUI useMediaQuery](https://mui.com/material-ui/react-use-media-query/).
3. **Fluid type + spacing with `clamp()`, not breakpoint jumps.** A scale of `clamp(min, rem+vw, max)` steps eliminates jarring jumps and dozens of overrides. A11y rules: always include a `rem` term (pure `vw` breaks zoom / fails WCAG 1.4.4); keep `max ≤ 2.5 × min`; keep body text fixed 16–18px (fluid the headings/titles). Source: [Utopia](https://utopia.fyi/blog/utopian-typography-is-easy/), [Adrian Roselli on zoom](https://adrianroselli.com/2019/12/responsive-type-and-zoom.html).
4. **Mobile-first, dynamic viewport units, intrinsic layouts.** Min-width up; `dvh`/`svh` not `vh`; CSS Grid `auto-fit/minmax` for column counts without media queries; `VisualViewport` for keyboard insets. Source: [Scrimba 2026 guide](https://scrimba.com/articles/responsive-web-design-a-complete-guide-2026-2/).

## Why the current app (and my patches) fall short

- **`usePlatform()`** (`src/hooks/use-platform.ts`) switches layout in JS at a fixed 768px viewport line, `"unknown"` until mount → first paint renders the desktop tree on phones, then swaps. It also can't know that the chat column is narrow because the _artifact panel is open on a wide screen_ — it only sees the viewport.
- **`sm:` overrides everywhere** (including the ones I just added) key off the viewport. The chat header/messages/composer live inside a column whose width changes with the sidebar and artifact panel. At 1400px viewport with both panels open, that column can be ~360px — phone-width — but every `sm:` rule thinks it's desktop. The components are styled for the wrong width.
- **Type/spacing are fixed jumps** (`text-[15px] md:text-[17px]`, fixed `px-4 md:px-6`). No fluid scale; readability and density are tuned only at the breakpoints we happened to test.
- **Touch targets**: fixed (now patched to 44px on mobile, correct) — keep this.

## The architecture

### A. Container contexts on the chat layout (highest leverage)

Make the chat regions query their own width instead of the viewport:

- Add `@container` to the message column and the composer wrapper in `chat-ui-layout.tsx` (the `flex-1 ... min-w-0` column) and name them (`@container/chat`, `@container/composer`).
- Convert component-internal breakpoints from `sm:`→`@sm`/`@md` in `chat-header.tsx`, `chat-header-buttons.tsx`, `chat-message.tsx`, the composer toolbar. Now "is there room for the Share button / the meta chips / the wide branch pills?" is answered by actual available width — correct whether narrow because of a phone or because panels are open.
- Keep **media queries** only for true page-level switches (sidebar → Sheet drawer, artifact panel → bottom drawer).

### B. Fluid type + spacing scale in `globals.css` `@theme`

Add a Utopia-style scale (rem+vw, max ≤ 2.5× min) and use it instead of `text-[Npx] md:text-[Mpx]`:

```css
@theme {
  --text-fluid-sm: clamp(0.875rem, 0.84rem + 0.18vw, 0.95rem);
  --text-fluid-base: clamp(
    1rem,
    0.96rem + 0.2vw,
    1.0625rem
  ); /* body: stays ~16–17px */
  --text-fluid-lg: clamp(1.0625rem, 0.99rem + 0.35vw, 1.25rem); /* titles */
  --space-fluid-edge: clamp(
    0.75rem,
    0.6rem + 0.75vw,
    1.5rem
  ); /* page gutters */
}
```

Body text stays in the 16–18px readable band; titles and gutters scale. Replaces the discrete jumps.

### C. Demote `usePlatform` to behavioral-only, SSR-safe

- Layout-only forks → CSS container/media queries (continue the W4 migration).
- Genuine forks that stay JS (drawer-vs-split-pane in `secondary-panel.tsx`, Enter-to-send): seed initial platform from a **server-readable cookie** so first paint matches the device (no flash). Write the cookie from a viewport probe; read it in the server layout.

### D. Composer keyboard + viewport (the real mobile-input fix)

- Size the chat shell with `dvh`, not `vh`/`h-screen`.
- Add a `VisualViewport` listener that sets a `--keyboard-inset` CSS var; pad the composer by it so the on-screen keyboard never covers it (the iOS-Safari case `interactiveWidget` doesn't handle).

## Sequencing

1. **A first** — container contexts on the chat column + convert the header/composer/message `sm:`→`@`. Biggest correctness win; fixes the panels-open-on-desktop case too.
2. **B** — fluid type/spacing tokens; swap the worst jump sites.
3. **D** — composer `dvh` + VisualViewport.
4. **C** — cookie-seeded platform (removes the last flash).

Verify each on the live dev server at 375px **and** at a wide viewport with both panels open (the case `sm:` gets wrong).

## Implemented (2026-05-25, verified live + tsc/biome clean)

- **A — container queries:** `@container/pane` on the chat pane, `@container/chat` on the message column. Header (`chat-header.tsx`, `chat-header-buttons.tsx`) converted from viewport `sm:` to container `@xl/pane:`. Proven by measurement: at an 820px desktop viewport with the artifact panel open (pane 487px), the header correctly shows mobile chrome (Share/Code hidden, 44px menu) — viewport breakpoints could not. Overflow menu now always renders so actions stay reachable on narrow panes.
- **B — fluid scale:** `--text-fluid-{sm,base,title}` + `--space-fluid-edge` (clamp, rem+vw, max ≤ 2.5× min) in `@theme`. Applied to message body (`text-part.tsx`, `chat-message.tsx`: 14px → 15–16px fluid), header title (dropped the `text-[15px] md:text-[17px]` jump), and header gutters.
- **D — keyboard:** `KeyboardInset` component sets `--keyboard-inset` from `VisualViewport`; composer padding folds it in. Self-correcting where `interactiveWidget` already handles the keyboard. The iOS-Safari-overlay lift cannot be verified on Chrome emulation — needs a real iOS device.
- **C — cookie-seeded platform:** `usePlatform` now reads a context seeded server-side from the `tg-platform` cookie (`use-platform.ts` → `.tsx`, `PlatformProvider` in `ServerProviders` above `SidebarProvider`). Returning visitors get a first paint that matches their device — no `unknown → desktop → swap` flash. No platform hydration mismatch observed.

### Found, pre-existing, out of scope

- Markdown hydration error: a shields.io badge `<img>` inside a markdown `<p>` renders as a block `ImagePart` `<div>`, invalid inside `<p>`. In the `prose` markdown path (unrelated to these changes). Worth a separate fix.

## Scope note

This is a real refactor, not a patch pass. A is the highest-value slice and can ship on its own. Recommend doing A end-to-end, verifying live, then B/D/C in follow-ups.

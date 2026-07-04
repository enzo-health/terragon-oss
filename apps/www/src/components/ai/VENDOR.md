# Vendored nauval components (`components/ai/*`)

These files are copied (shadcn-style) from [`nauvalazhar/ai`](https://github.com/nauvalazhar/ai)
(docs at [ai.nauv.al](https://ai.nauv.al)). There is no npm package — re-running a
vendor pass regenerates them from upstream.

**Layer A (purity).** Everything in `components/ai/*` is pure, prop-driven UI: a
component takes its visual `state` as plain string/boolean/number props the call
site computes. These files must NOT import `@terragon/*` or any store (`jotai`).
The Terragon adaptations live in the transcript leaves
(`chat/transcript-view/leaves/*`, `chat/chat-message-system.tsx`), which compute
plain view props (e.g. `leaves/tool-view-props.ts`) and pass them down. The
boundary is enforced by a Biome `noRestrictedImports`
override scoped to `**/apps/www/src/components/ai/**` in the repo-root
`biome.json` (the repo lints with Biome, not ESLint — this is the functional
equivalent of the planned ESLint `no-restricted-imports` rule).

## Provenance

| Upstream repo        | `nauvalazhar/ai`                           |
| -------------------- | ------------------------------------------ |
| Vendored at SHA      | `9944bcffc7412b27315ce853a49b4ea6035dea98` |
| Upstream commit date | 2026-05-26                                 |
| Vendored on          | 2026-06-02 (base 4); 2026-07-02 (P1 set)   |
| Upstream path        | `src/components/ai/<name>.tsx`             |

**License note.** `nauvalazhar/ai` has NO `LICENSE` file and GitHub reports
`license: null`. The basis for vendoring is the repo README's explicit
shadcn-style statement — "Drop the source into your project, restyle with tokens
or Tailwind, and compose freely" — plus the absence of any npm package (copying
source is the only intended distribution path). This is a copy-freely reading,
not a formal grant; if that basis is ever disputed, this whole directory is the
liability. Re-confirm on each vendor pass.

**P1 refresh check (2026-07-02).** Upstream `main` HEAD is still
`9944bcf` — identical to the pinned SHA — so the base 4 files (`tool`,
`reasoning`, `message`, `callout`) had zero upstream deltas to port. The P1 set
below was fetched at the same SHA.

Every file below maps 1:1 to `github.com/nauvalazhar/ai/blob/9944bcf/src/components/ai/<name>.tsx`.

| File                   | Upstream               | Primitive                               | Notes                                                     |
| ---------------------- | ---------------------- | --------------------------------------- | --------------------------------------------------------- |
| `tool.tsx`             | `tool.tsx`             | `@base-ui/react/collapsible`            | also `partial-json`                                       |
| `reasoning.tsx`        | `reasoning.tsx`        | `@base-ui/react/collapsible`            |                                                           |
| `message.tsx`          | `message.tsx`          | none (div + `cva`)                      |                                                           |
| `callout.tsx`          | `callout.tsx`          | `@base-ui/react/use-render` + `cva`     |                                                           |
| `confirmation.tsx`     | `confirmation.tsx`     | `@base-ui/react/use-render` + `cva`     | React context (controllable)                              |
| `diff.tsx`             | `diff.tsx`             | `@base-ui/react/collapsible`            | also `diff`; exports `useDiff`                            |
| `todo.tsx`             | `todo.tsx`             | `@base-ui/react/collapsible`            |                                                           |
| `task.tsx`             | `task.tsx`             | none (div + `cn`)                       |                                                           |
| `status.tsx`           | `status.tsx`           | `@base-ui/react/use-render` + `cva`     |                                                           |
| `usage-meter.tsx`      | `usage-meter.tsx`      | `@base-ui/react/meter` + `cva`          | rAF `AnimatedNumber`                                      |
| `exception.tsx`        | `exception.tsx`        | `@base-ui/react/collapsible`            |                                                           |
| `conversation.tsx`     | `conversation.tsx`     | `@base-ui/react/use-render`             | exports `useConversation`; ResizeObserver stick-to-bottom |
| `chain-of-thought.tsx` | `chain-of-thought.tsx` | `@base-ui/react/collapsible`            |                                                           |
| `loader.tsx`           | `loader.tsx`           | `@base-ui/react/use-render` + `cva`     | keyframes below                                           |
| `source.tsx`           | `source.tsx`           | `@base-ui/react/use-render` + `cva`     |                                                           |
| `citation.tsx`         | `citation.tsx`         | `@base-ui/react/popover` + `use-render` | keyframes below                                           |
| `attachment.tsx`       | `attachment.tsx`       | `@base-ui/react/use-render` + `cva`     | React 19 context-as-provider                              |
| `agent-run.tsx`        | `agent-run.tsx`        | `@base-ui/react/collapsible`            |                                                           |
| `action.tsx`           | `action.tsx`           | `@base-ui/react/collapsible`            |                                                           |

### Composer family + full sweep (2026-07-03)

Upstream `main` HEAD is still `9944bcf` — the pinned SHA — so these 29 files map
1:1 to `github.com/nauvalazhar/ai/blob/9944bcf/src/components/ai/<name>.tsx` with
zero upstream deltas to reconcile. The composer family (9) covers the rich input
stack and its shared primitives (`composer`, `composer-rich`, `button`, `chip`,
`popover`, `menu`, `select`, `switch`, `tooltip`); the remaining 20 complete the
library sweep. `chip.tsx` is a shared primitive with no standalone story.

| File                  | Upstream              | Primitive                                                                                          | Notes                                                      |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `button.tsx`          | `button.tsx`          | `@base-ui/react/button` + `cva`                                                                    |                                                            |
| `chip.tsx`            | `chip.tsx`            | `@base-ui/react/use-render` + `cva`                                                                | no story (shared primitive)                                |
| `popover.tsx`         | `popover.tsx`         | `@base-ui/react/popover`                                                                           |                                                            |
| `menu.tsx`            | `menu.tsx`            | `@base-ui/react/menu` + `cva`                                                                      |                                                            |
| `select.tsx`          | `select.tsx`          | `@base-ui/react/select` + `cva`                                                                    | imports `chip.tsx`                                         |
| `switch.tsx`          | `switch.tsx`          | `@base-ui/react/switch` + `cva`                                                                    |                                                            |
| `tooltip.tsx`         | `tooltip.tsx`         | `@base-ui/react/tooltip`                                                                           |                                                            |
| `composer.tsx`        | `composer.tsx`        | `@base-ui/react/use-render`                                                                        |                                                            |
| `composer-rich.tsx`   | `composer-rich.tsx`   | TipTap (`@tiptap/core`, `@tiptap/pm`, `@tiptap/react`, `starter-kit`, `placeholder`, `suggestion`) | wraps `composer.tsx`; `react-dom/createPortal`; `!` deltas |
| `scroll-area.tsx`     | `scroll-area.tsx`     | `@base-ui/react/scroll-area`                                                                       | `--color-scrollbar` alias                                  |
| `model-selector.tsx`  | `model-selector.tsx`  | `@base-ui/react/autocomplete` + `cva`                                                              |                                                            |
| `suggestion.tsx`      | `suggestion.tsx`      | `@base-ui/react/use-render` + `cva`                                                                |                                                            |
| `selection.tsx`       | `selection.tsx`       | none (`react-dom/createPortal`)                                                                    | imports `button.tsx`; `!` deltas                           |
| `console.tsx`         | `console.tsx`         | `@base-ui/react/collapsible` + `use-render`                                                        |                                                            |
| `sandbox.tsx`         | `sandbox.tsx`         | `@base-ui/react/collapsible` + `@base-ui/react/tabs`                                               |                                                            |
| `spec.tsx`            | `spec.tsx`            | `@base-ui/react/collapsible`                                                                       |                                                            |
| `web-preview.tsx`     | `web-preview.tsx`     | `@base-ui/react/collapsible` + `use-render`                                                        |                                                            |
| `document.tsx`        | `document.tsx`        | `@base-ui/react/use-render`                                                                        |                                                            |
| `env.tsx`             | `env.tsx`             | `@base-ui/react/use-render`                                                                        |                                                            |
| `feedback-bar.tsx`    | `feedback-bar.tsx`    | `@base-ui/react/use-render`                                                                        |                                                            |
| `prompt.tsx`          | `prompt.tsx`          | `@base-ui/react/use-render`                                                                        |                                                            |
| `uploader.tsx`        | `uploader.tsx`        | `@base-ui/react/use-render`                                                                        | `!` deltas                                                 |
| `file-tree.tsx`       | `file-tree.tsx`       | none (recursive div + `cn`)                                                                        | `!` deltas                                                 |
| `code-block.tsx`      | `code-block.tsx`      | `@base-ui/react/use-render`                                                                        | prop-driven; no highlighter dep                            |
| `generated-image.tsx` | `generated-image.tsx` | `@base-ui/react/use-render` + `cva`                                                                | keyframe `generated-image-pulse`                           |
| `player.tsx`          | `player.tsx`          | `@base-ui/react/use-render` + `react-player` + `youtube-video-element`                             | keyframe `player-waveform-loading`; `!` deltas             |
| `transcript.tsx`      | `transcript.tsx`      | `@base-ui/react/use-render`                                                                        | imports `player.tsx`                                       |
| `markdown.tsx`        | `markdown.tsx`        | `react-markdown` + `remark-gfm`                                                                    | wraps `code-block.tsx`; parity-only, NOT adopted           |
| `diff-rich.tsx`       | `diff-rich.tsx`       | `shiki/core` + `@shikijs/langs` + `@shikijs/themes`                                                | wraps `diff.tsx`; parity-only, NOT adopted                 |

New Base UI subpaths pulled in by this sweep (`@base-ui/react/button`, `/menu`,
`/select`, `/switch`, `/tooltip`, `/autocomplete`, `/scroll-area`, `/tabs`) are
all present in the pinned `1.5.0`; no file references a subpath the version lacks.

## Dependencies added for these files

Exact-pinned in `apps/www/package.json` (the consolidation invariant forbids
caret/tilde ranges on chat-layer deps):

| Package          | Version | Used by                                                    |
| ---------------- | ------- | ---------------------------------------------------------- |
| `@base-ui/react` | `1.5.0` | most leaves (collapsible/use-render/popover/meter)         |
| `partial-json`   | `0.1.7` | `tool.tsx` (streaming arg parse)                           |
| `diff`           | `8.0.3` | `diff.tsx` (`diffLines`/`diffWordsWithSpace`/`parsePatch`) |

`class-variance-authority`, `clsx`, `tailwind-merge`, and `lucide-react` were
already present. None of the vendored files import `lucide-react` — icons are
inline SVG.

**`diff` (NEW dependency, added for P1).** `diff.tsx` computes line- and
word-level diffs from either a unified patch or a `{from,to}` string pair.
Pinned EXACT (`8.0.3` — already resolvable in the monorepo store; ships its own
types, so no `@types/diff`). This is the only new third-party dependency in the
P1 set.

**Added in the sweep pass (2026-07-03).** Exact-pinned unless the package was
already present in the app under a caret range shared with the rest of the
codebase (TipTap), in which case the new subpath packages track that same range
for lockfile consistency:

| Package                 | Version   | Pin   | Used by                                                       |
| ----------------------- | --------- | ----- | ------------------------------------------------------------- |
| `@shikijs/langs`        | `3.23.0`  | exact | `diff-rich.tsx` (Shiki grammar set; matches existing `shiki`) |
| `@shikijs/themes`       | `3.23.0`  | exact | `diff-rich.tsx` (Shiki themes; matches existing `shiki`)      |
| `react-markdown`        | `10.1.0`  | exact | `markdown.tsx`                                                |
| `remark-gfm`            | `4.0.1`   | exact | `markdown.tsx` (GFM tables/strikethrough)                     |
| `react-player`          | `3.4.0`   | exact | `player.tsx` (media playback + `patterns`/`players`)          |
| `youtube-video-element` | `1.9.0`   | exact | `player.tsx` (YouTube custom element, lazy-imported)          |
| `@tiptap/core`          | `^2.14.0` | caret | `composer-rich.tsx` (`Extension`/`Node`/`mergeAttributes`)    |
| `@tiptap/pm`            | `^2.14.0` | caret | `composer-rich.tsx` (`@tiptap/pm/state` `PluginKey`)          |

`shiki` (`3.23.0`) was already present; `diff-rich.tsx` pulls its `/core` and
`/engine/oniguruma` entrypoints plus the two new `@shikijs/*` grammar/theme
packages at the same version. The remaining `@tiptap/*` packages
(`react`/`starter-kit`/`extension-placeholder`/`suggestion`) were already
declared for the existing promptbox and are reused verbatim.

**Base UI subpaths used by P1 (verified present in `1.5.0`):**
`@base-ui/react/popover` (`citation.tsx`) and `@base-ui/react/meter`
(`usage-meter.tsx`) join the previously-used `/collapsible` and `/use-render`.
No component references a subpath the pinned version lacks.

**Base UI primitive stack.** Per the program plan (grill-me-glimmering-wolf.md),
the app is migrating Radix → Base UI app-wide (WS-A), so these components are
kept on Base UI as-is rather than retargeted onto Radix. nauval's package is
`@base-ui/react` (the current name; the older `@base-ui-components/react` is
stuck at RC and is NOT what nauval uses). Submodule import paths
(`@base-ui/react/collapsible`, `/use-render`, `/meter`) are kept verbatim.

## Local deltas (re-apply on regeneration)

Kept minimal — only what the repo's stricter toolchain requires. Re-running the
vendor pass overwrites these; reapply the alias rewrite plus the items below.

1. **Import alias.** `#/lib/utils` → `@/lib/utils` (every file).
2. **`"use client"`.** Prepended to every file that lacked it upstream (all
   except `diff.tsx`, which ships it). These components use React hooks / Base UI
   and render in the client chat tree.
3. **`diff.tsx` non-null assertions.** Terragon's tsconfig sets
   `noUncheckedIndexedAccess: true`; upstream `diff.tsx` indexes arrays inside
   length-bounded loops without guards, which the stricter config rejects. Added
   `!` on the loop-bounded index accesses (`lines[i]`/`lines[j]`/`lines[k]` in
   `collapseContext`, `parts[i]` in `computeFromStrings`, `parsed.hunks[hi]` and
   `raw[i]` in `computeFromPatch`). Type-level only — zero runtime/logic change.
4. **Sweep-set non-null assertions.** Same `noUncheckedIndexedAccess` cause as
   item 3: `file-tree.tsx`, `player.tsx`, `uploader.tsx`, `selection.tsx`, and
   `composer-rich.tsx` index arrays inside length-bounded loops / after
   presence checks that the stricter config cannot narrow, so `!` was added on
   those loop-bounded accesses. Type-level only — zero runtime/logic change.
5. **`composer-rich.tsx` `immediatelyRender: false`.** Upstream targets Vite
   (client-only); under Next.js SSR, TipTap's `useEditor` without
   `immediatelyRender: false` logs a hydration-mismatch error on every mount.
   Added the option to the `useEditor` call. Next-specific integration delta,
   zero client-side behavior change.
6. **Comment strip.** The three short upstream comments in `player.tsx` and the
   two `eslint-disable-next-line` directives in `composer.tsx`/`composer-rich.tsx`
   were removed post-vendor (repo zero-comment rule; the repo lints with Biome,
   so the ESLint directives were dead). Re-strip on regeneration.

No other edits to the vendored `.tsx` files — no token hardcoding, no logic
changes.

Story-fixture deltas (not vendored source): `console.stories.tsx` gained one `!`
on a modulo-indexed `levels[i % levels.length]` fixture access — the same
stricter-config pattern, in a story-only array.

## Theming: nauval token → existing `@theme` alias (I5)

Audit of the semantic Tailwind tokens the vendored files reference, against
the registrations in `apps/www/src/app/globals.css` (`@theme inline`, ~line 291).
All required aliases now resolve: the `surface` / `surface-elevated` / `inflight`
mappings below are registered in `globals.css` alongside `--color-surface-soft`.

**Already resolve (no action — registered in `@theme inline`):**

| nauval token                                 | resolves via                                                    |
| -------------------------------------------- | --------------------------------------------------------------- |
| `text/bg-muted-foreground`, `bg-muted`       | `--color-muted-foreground`, `--color-muted`                     |
| `text-foreground`, `bg-background`           | `--color-foreground`, `--color-background`                      |
| `text/bg-destructive`                        | `--color-destructive`                                           |
| `border-border`                              | `--color-border`                                                |
| `bg/text-primary`, `text-primary-foreground` | `--color-primary`, `--color-primary-foreground`                 |
| `bg/text-accent`                             | `--color-accent`                                                |
| `text-success`, `text-warning`               | `--color-success`, `--color-warning` (canonical 11-token block) |

**Registered in `@theme inline` for the vendored leaves:**

| nauval token                                               | alias                                              | rationale                                                                                              |
| ---------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bg/border-surface`                                        | `--color-surface: var(--muted)`                    | the card/panel tone — must differ from `--background`/`--card` (both pure white) or the panel vanishes |
| `bg-surface-elevated`                                      | `--color-surface-elevated: var(--card)`            | white inset blocks/bubbles that sit above the gray surface                                             |
| `*-inflight` (nauval's in-progress accent, refs in `tool`) | `--color-inflight: var(--info)`                    | maps the streaming/in-flight accent onto the existing info hue; revisit if a distinct accent is wanted |
| `rounded-outer` (cards/bubbles, refs in `tool`/`message`)  | `--radius-outer: calc(var(--radius) + 8px)` (16px) | nauval wraps cards in `rounded-outer`; undefined → square corners                                      |

**Added in the P1 pass (2026-07-02):**

| nauval token                                   | alias                                      | rationale                                                                      |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `*-diff-added` (`diff.tsx` green add lines)    | `--color-diff-added: var(--success)`       | maps add-line green onto the app's existing success hue (carries light + dark) |
| `*-diff-removed` (`diff.tsx` red remove lines) | `--color-diff-removed: var(--destructive)` | maps remove-line red onto the single canonical destructive red                 |

That is 6 aliases total, matching the plan's "~3–6 `@theme inline` aliases, not a
token system" estimate. No `:root`/`.dark` duplication is needed — each target
token (`--card`, `--raised`, `--info`, `--success`, `--destructive`) already
carries light + dark values.

Audit result for the rest of the P1 set: Status/AgentRun/Tool level colors resolve
via `--color-inflight`/`--color-warning`/`--color-success`/`--color-destructive`;
Exception accents and UsageMeter over-state resolve via `--color-destructive`;
UsageMeter fill via `--color-primary`. No further color aliases required.

**Keyframes added to `globals.css` (P1).** Three leaves reference upstream
`@keyframes` by name via Tailwind arbitrary `animate-[<name>_…]` utilities;
without the definitions the animations silently no-op. Copied verbatim from
`nauvalazhar/ai@9944bcf` `src/styles/tokens.css`:

| keyframe                                     | used by        |
| -------------------------------------------- | -------------- |
| `text-pulse`, `text-shimmer`, `loading-dot`  | `loader.tsx`   |
| `citation-enter-next`, `citation-enter-prev` | `citation.tsx` |

**Keyframes added in the sweep pass (2026-07-03).** With Player and Generated
Image now vendored, their two upstream keyframes were copied verbatim from
`nauvalazhar/ai@9944bcf` `src/styles/tokens.css`:

| keyframe                  | used by               |
| ------------------------- | --------------------- |
| `player-waveform-loading` | `player.tsx`          |
| `generated-image-pulse`   | `generated-image.tsx` |

**Scrollbar alias added in the sweep pass.** `scroll-area.tsx` references
`bg-scrollbar`; registered as `--color-scrollbar: var(--mid)` in `@theme inline`
(the existing neutral `--mid` hue carries light + dark), so the custom scrollbar
thumb is visible instead of transparent.

**Markdown + rich diff: vendored for parity, NOT adopted in production.**
`markdown.tsx` and `diff-rich.tsx` are now vendored so the library is complete
and every story renders, but neither is wired into the live transcript. The
transcript keeps the streamdown renderer
(`chat/ai-elements/markdown-renderer.tsx`) — AGENTS.md's justified divergence —
because streamdown exposes `parseIncompleteMarkdown` for streaming-token UX that
`react-markdown` does not, and the plain `diff.tsx` + `useDiff` path already
covers the transcript's diff need without routing the diff path through Shiki.
They exist as reference/parity leaves only; adopting either is a separate,
deliberate decision, not a default.

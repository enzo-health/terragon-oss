# Vendored nauval components (`components/ai/*`)

These files are copied (shadcn-style) from [`nauvalazhar/ai`](https://github.com/nauvalazhar/ai)
(docs at [ai.nauv.al](https://ai.nauv.al)). There is no npm package — re-running a
vendor pass regenerates them from upstream.

**Layer A (purity).** Everything in `components/ai/*` is pure, prop-driven UI: a
component takes its visual `state` as plain string/boolean/number props the call
site computes. These files must NOT import `@assistant-ui/*`, `@terragon/*`, or
any store (`jotai`). The Terragon adaptations live in the binding shells
(`chat/assistant-ui/native-thread.tsx`, `chat/chat-message-system.tsx`), which
call the view-props adapter (`chat/assistant-ui/native-thread-utils.ts`) and pass
plain props down. The boundary is enforced by a Biome `noRestrictedImports`
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

No other edits — no token hardcoding, no logic changes, no comments added to the
vendored `.tsx` files (they carry none upstream).

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

nauval's `player-waveform-loading` / `generated-image-pulse` keyframes are NOT
copied — Player and Generated Image are outside the P1 set.

**Markdown:** streamdown stays (`chat/ai-elements/markdown-renderer.tsx`). nauval
`markdown.tsx` is NOT vendored — adopting it would lose `parseIncompleteMarkdown`
streaming. nauval `diff-rich.tsx` (Shiki-highlighted diff) is also NOT vendored —
plain `diff.tsx` + `useDiff` covers the P1 need and avoids pulling Shiki as a new
diff-path dependency.

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
| Vendored on          | 2026-06-02                                 |
| Upstream path        | `src/components/ai/<name>.tsx`             |

Every file below maps 1:1 to `github.com/nauvalazhar/ai/blob/9944bcf/src/components/ai/<name>.tsx`.

| File               | Upstream           | Primitive                           | Notes                                                                                     |
| ------------------ | ------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `tool.tsx`         | `tool.tsx`         | `@base-ui/react/collapsible`        | also `partial-json`                                                                       |
| `reasoning.tsx`    | `reasoning.tsx`    | `@base-ui/react/collapsible`        |                                                                                           |
| `message.tsx`      | `message.tsx`      | none (div + `cva`)                  |                                                                                           |
| `conversation.tsx` | `conversation.tsx` | `@base-ui/react/use-render`         | owns its own scroll state — do NOT let it own transcript autoscroll on integration        |
| `console.tsx`      | `console.tsx`      | `collapsible` + `use-render`        |                                                                                           |
| `status.tsx`       | `status.tsx`       | `@base-ui/react/use-render` + `cva` |                                                                                           |
| `callout.tsx`      | `callout.tsx`      | `@base-ui/react/use-render` + `cva` |                                                                                           |
| `composer.tsx`     | `composer.tsx`     | `@base-ui/react/use-render`         | local delta: ESLint→Biome ignore (see below)                                              |
| `loader.tsx`       | `loader.tsx`       | `@base-ui/react/use-render` + `cva` |                                                                                           |
| `source.tsx`       | `source.tsx`       | `@base-ui/react/use-render` + `cva` |                                                                                           |
| `player.tsx`       | `player.tsx`       | `@base-ui/react/use-render`         | pulls `react-player` + `youtube-video-element`; only used by the dead-path audio renderer |
| `attachment.tsx`   | `attachment.tsx`   | `@base-ui/react/use-render` + `cva` |                                                                                           |
| `uploader.tsx`     | `uploader.tsx`     | `@base-ui/react/use-render`         |                                                                                           |
| `usage-meter.tsx`  | `usage-meter.tsx`  | `@base-ui/react/meter` + `cva`      |                                                                                           |
| `todo.tsx`         | `todo.tsx`         | `@base-ui/react/collapsible`        |                                                                                           |
| `code-block.tsx`   | `code-block.tsx`   | `@base-ui/react/use-render`         |                                                                                           |
| `file-tree.tsx`    | `file-tree.tsx`    | none (roving-focus tree)            |                                                                                           |

## Dependencies added for these files

Exact-pinned in `apps/www/package.json` (the consolidation invariant forbids
caret/tilde ranges on chat-layer deps):

| Package                 | Version | Used by                                                       |
| ----------------------- | ------- | ------------------------------------------------------------- |
| `@base-ui/react`        | `1.5.0` | most files (collapsible / use-render / meter)                 |
| `partial-json`          | `0.1.7` | `tool.tsx` (streaming arg parse)                              |
| `react-player`          | `3.4.0` | `player.tsx`                                                  |
| `youtube-video-element` | `1.9.0` | `react-player` YouTube provider (lazy import in `player.tsx`) |

`class-variance-authority`, `clsx`, `tailwind-merge`, and `lucide-react` were
already present. None of the vendored files import `lucide-react` — icons are
inline SVG.

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
2. **`"use client"`.** Prepended to files that lacked it upstream (all but
   `player.tsx` and `file-tree.tsx`, which already had it). These components use
   React hooks / Base UI and render in the client chat tree.
3. **`noUncheckedIndexedAccess` guards** (repo `tsconfig` is stricter than
   nauval's). Faithful, behavior-preserving:
   - `file-tree.tsx`: `if (!row) break;` after `const row = rows[currentIndex]`
     (ArrowRight, ArrowLeft); `rows[i]?.dataset` and `rows[currentIndex]?.click()`.
   - `uploader.tsx`: hoist `const blobUrl = next[id]` and guard before
     `URL.revokeObjectURL`.
   - `player.tsx`: `channel[j] ?? 0` and `peaks[i] ?? 0`.
4. **Linter suppression syntax.** `composer.tsx` upstream uses an
   `// eslint-disable-next-line react-hooks/exhaustive-deps` on a mount-only
   `useLayoutEffect`. The repo lints with Biome, so it was rewritten to
   `// biome-ignore lint/correctness/useExhaustiveDependencies: …`. Same intent
   (focus on mount only).

No other edits — no token hardcoding, no logic changes.

## Theming: nauval token → existing `@theme` alias (I5)

Audit of the semantic Tailwind tokens the 17 vendored files reference, against
the registrations in `apps/www/src/app/globals.css` (`@theme inline`, ~line 291).
Most already resolve. The aliases below are **not yet added** — this is the
theming-prep mapping; the `@theme inline` edits land with the chat re-skin
(globals.css is outside this prep task's file partition).

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

**Need a one-line alias (NOT registered today) — add to `@theme inline`:**

| nauval token                                                                   | suggested alias                           | rationale                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bg/border-surface`                                                            | `--color-surface: var(--card)`            | nauval's base card surface = Terragon cream card                                                       |
| `bg-surface-elevated`                                                          | `--color-surface-elevated: var(--raised)` | raised ladder stop (matches `--color-surface-soft: var(--raised)` already present)                     |
| `*-inflight` (nauval's in-progress accent, 4 refs in `tool`/`status`/`loader`) | `--color-inflight: var(--info)`           | maps the streaming/in-flight accent onto the existing info hue; revisit if a distinct accent is wanted |

That is 3 aliases, matching the plan's "~3–6 `@theme inline` aliases, not a token
system" estimate. No `:root`/`.dark` duplication is needed — each target token
(`--card`, `--raised`, `--info`) already carries light + dark values.

**Markdown:** streamdown stays (`chat/ai-elements/markdown-renderer.tsx`). nauval
`markdown.tsx` is NOT vendored — adopting it would lose `parseIncompleteMarkdown`
streaming. Diff/markdown tokens are intentionally skipped.

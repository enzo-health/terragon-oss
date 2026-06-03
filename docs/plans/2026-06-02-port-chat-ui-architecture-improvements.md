# Architecture improvements to fold into the nauval UI port (and what to NOT do)

Status: proposed
Date: 2026-06-02
Owner: chat layer

Companion to `docs/plans/2026-06-02-port-chat-ui-to-nauval-components.md`. That plan skins the live render seams with vendored nauval components and keeps AG-UI transport. This doc answers a narrower question: **which codebase architecture improvements should ride that port, which are safer as a separate slice after it, and which must we explicitly not do?** Phase numbers below refer to the port plan's seven phases (Phase 0–7).

Every improvement here is subtractive or net-simplifying. The two net-additive items (a vendored-purity lint rule, a live-surface story + assertion) carry explicit justifications.

---

## Recommendation (top)

**Do these DURING the port, in priority order:**

1. **(Highest leverage) Delete the dead _agent/tool_ rendering path — do NOT skin it (re-scoped Phase 7).** The single largest subtractive win. Re-scope the conditional Phase 7 from "skin the dead surface" to "delete the dead surface," but the target is the **agent-and-tool** branch only — `PART_REGISTRY`'s agent/tool leaves, `TOOL_DISPATCH`, the 20 tool leaves, `CollapsibleAgentActivityGroup`, and the agent-message chrome. The shared dispatch infrastructure (`MessagePart`, `groupParts`, `ImageGroup`, the five user-part renderers, the user-bubble chrome) **stays — it is live for queued user messages.** Gated on the Phase 0 consolidation answer.
2. **Delete the `runtime-fingerprint` + `runtime-part-conversion` island NOW — no gate (Phase 0).** Provably dead: the only importer of `runtime-fingerprint.ts` is its own test; the only importer of `runtime-part-conversion.ts` is `runtime-fingerprint.ts`. ~629 source lines + 103 test, zero behavioral risk, no gate dependency. The cheapest clean win in the whole port.
3. **Name and extend `native-thread-utils.ts` as THE live view-props adapter (Phases 1–3).** The seam already exists for tools. Add a ~30-line `reasoningViewProps` so `NativeReasoning` becomes a pure shell, write down the one-line contract, and stop there. No adapter framework.
4. **Enforce vendored-leaf purity with one ESLint `no-restricted-imports` rule (Phase 0).** The one net-additive config item, and it earns its place: it keeps the next re-skin cheap forever by banning `@assistant-ui/*` and `@terragon/*` imports inside `components/ai/**`. ~10 lines.
5. **Reuse the existing `@theme inline` alias seam; do NOT build a parallel nauval token set (Phase 0).** The work the plan budgets as greenfield is mostly done — `--color-surface-soft`, `--color-error`, `border-border`, `text-muted-foreground` already resolve. Phase 0 is a ~3–6-line alias audit, not a token system.
6. **Add a live-surface story + one harness DOM assertion (Phase 0 / Phase 3).** All 19 chat stories target the dead path; the live `NativeToolCall` state branches are unguarded. One `native-thread.stories.tsx` and ~2 DOM-shape assertions close the only real coverage gap for the highest-leverage phases.

Two smaller riders fold into Phase 4 without their own slice: hoist `SystemMessage`'s `getLabel`/`getDotClassName` to module scope (I7), and rewire `TerragonSystemMessage` to take `onOpenRepoFile` from context instead of the prop bag (I8).

**Deferred to a separate slice (safer after the port):**

- **Option B (route live tool parts through `TOOL_DISPATCH`)** — real feature work (per-tool richness in the live transcript), not unification. Resolve the two lenses' cost disagreement with a spike built fresh against `NativeToolCall`, never inside the cosmetic port.
- **Full deletion of the `messagePartProps`/`toolProps` bag** — the bag still flows into the live user-part `MessagePart` render, so deleting the dead agent/tool path does **not** fully unlock it. Narrow the one live system consumer (I8) during the port; defer the bag's full removal until the user-part render path is also re-pointed (a follow-on slice).

**Do NOT do (phantom problems — see YAGNI guardrails):**

- A presentation-adapter framework, a runtime-exhaustiveness guard for native tool states, splitting `TextPart`'s streaming machine into the adapter, a parallel nauval token block, Base UI as a second primitive stack, DB data-model edits, atom consolidation, HTML snapshot tests, or backfilling stories for dead leaves.

---

## Target architecture

```
TODAY (one live agent path + a partially-live legacy ChatMessage):

  AG-UI transport ──> runtime (ThreadMessage[]) ──> native-thread.tsx     ── LIVE ──> agent transcript
                                                       NativeText/Reasoning/
                                                       ToolCall/ToolGroup
                                                       (hand-rolled <details>)

  queued user msgs ──> ChatMessage (role:"user", non-system branch) ── LIVE ──> queued-message preview
                          groupParts → MessagePart → PART_REGISTRY
                          → {text,image,rich-text,pdf,text-file} renderers + ImageGroup
                          (mounted via thread-promptbox.tsx → QueuedMessages)

  ChatMessage agent branch (role:"agent") ── DEAD ──> no live caller
       CollapsibleAgentActivityGroup → MessagePart → PART_REGISTRY agent/tool leaves
       → TOOL_DISPATCH → 20 tool leaves
  (+ runtime-fingerprint / runtime-part-conversion island: dead, 0 render consumers)

CONVERGED (one agent path + the slimmed user-part path, pure leaves, thin adapters, transport unchanged):

  AG-UI transport ──> runtime (ThreadMessage[]) ──> native-thread.tsx  (Layer B: binding shells, Terragon-owned)
       (UNCHANGED)         (UNCHANGED)                  │  calls native-thread-utils.ts (THE adapter: pure fns,
       routeComposerSubmit                              │  string/bool/enum out — never a runtime part)
       → runtime.append                                 ▼
       → followUp()                            components/ai/*  (Layer A: vendored nauval, PURE)
       (writer pipeline                          Tool / Reasoning / Message / Status / Callout
        UNCHANGED)                                │  ESLint-banned from importing @assistant-ui/* or @terragon/*
                                                  ▼  styled via existing @theme aliases (globals.css)
                                          Radix primitives (existing 18 pkgs) or <details> — NO Base UI

  KEPT LIVE: MessagePart · groupParts · ImageGroup · {text,image,rich-text,pdf,text-file} renderers ·
             user-bubble chrome  (reachable via QueuedMessages)
  DELETED:   TOOL_DISPATCH · 20 tool leaves · PART_REGISTRY agent/tool leaves ·
             CollapsibleAgentActivityGroup · ChatMessage agent (role:"agent") chrome ·
             runtime-fingerprint + runtime-part-conversion
  REPLACED BY: one ~15-line Assert<> exhaustiveness const for the agent-part keys
               native-thread now handles, co-located with native-thread.tsx
```

The contrast is the point: today there is one live agent renderer (`native-thread.tsx`) and a second, _partially_ live legacy renderer (`ChatMessage` — live for queued **user** parts, dead for **agent/tool** parts). The dead half carries the exhaustiveness scaffolding that makes the whole thing look worth keeping. Converged state deletes only the dead agent/tool half, keeps the user-part path that queued messages need, and replaces the agent-part scaffolding with one small compile-time guard — with AG-UI transport and the `followUp()` writer pipeline untouched.

---

## Ranked improvements

| #   | Problem (one line)                                                            | Change                                                                       | Phase         | Complexity delta           | Risk                                           | Origin                 |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------- | -------------------------- | ---------------------------------------------- | ---------------------- |
| I1  | Two agent renderers; the legacy `ChatMessage` **agent/tool** branch is dead   | Tripwire then delete the agent/tool half only; keep the user-part path       | 7 (re-scoped) | Strongly subtractive       | "Dead is live" — mitigated by tripwire+harness | KEEP (re-scoped)       |
| I2  | `runtime-fingerprint`/`runtime-part-conversion` island has 0 render consumers | Delete both modules + test                                                   | 0             | −629 src lines, +0         | Near-zero                                      | KEEP                   |
| I3  | `NativeReasoning` derives view state inline; no adapter seam                  | Add `reasoningViewProps`; document the one-line adapter contract             | 1–3           | Neutral-to-negative        | Very low                                       | KEEP                   |
| I4  | Plan states vendored-purity in prose; nothing enforces it                     | One ESLint `no-restricted-imports` on `components/ai/**`                     | 0             | +~10 lines (justified)     | Low                                            | KEEP                   |
| I5  | Plan budgets greenfield token mapping that already exists                     | Phase 0 = alias _audit_, ~3–6 `@theme inline` aliases                        | 0             | Strongly negative vs. plan | Very low                                       | KEEP                   |
| I6  | nauval primitives sit on Base UI; repo has zero Base UI, 18 Radix             | Retarget base-scope primitives onto Radix/`<details>`; no Base UI            | 0             | Strongly negative          | Low                                            | KEEP                   |
| I7  | `getLabel`/`getDotClassName` are component-local closures with `never` guards | Hoist to module-scope pure fns before Phase 4 skins the rows                 | 4             | Neutral                    | Low                                            | KEEP                   |
| I8  | Live `TerragonSystemMessage` reaches `onOpenRepoFile` through the prop bag    | Take it from `useTerragonThread()` context instead                           | 4             | Net-neutral (rewire)       | Low–medium                                     | KEEP (claim corrected) |
| I9  | All 19 stories test the dead path; live `NativeToolCall` branches unguarded   | `native-thread.stories.tsx` + ~2 DOM assertions in the streaming-budget test | 0 / 3         | +~130 lines (justified)    | Low                                            | KEEP                   |

### I1 — Delete the dead agent/tool rendering path (re-scope Phase 7 from "skin" to "delete") — HIGHEST LEVERAGE

- **Problem.** Two renderers exist for agent parts; the legacy `ChatMessage` **agent** branch (`role: "agent"`) is dead. **Important topology correction, verified in this tree:** `ChatMessage`'s non-system branch is **not** entirely dead. `promptbox/queued-messages.tsx` builds `role: "user"` UI messages (`queuedUserMessageToUiMessage`, line 89) and renders them through `ChatMessage`, which runs `groupParts` → `MessagePart` → `PART_REGISTRY`. It is mounted live: `chat-prompt-box.tsx` → `thread-promptbox.tsx:227` → `<QueuedMessages>`. Queued user messages carry `text | image | rich-text | pdf | text-file` parts (`db-message.ts:27-33`), so those five `PART_REGISTRY` renderers, `MessagePart`, `groupParts`, `ImageGroup`, and the user-bubble chrome (`chat-message.tsx:182-185`) are **LIVE**. What is dead is the **agent/tool** surface reachable only from the `role: "agent"` branch: `CollapsibleAgentActivityGroup`, the agent/tool `PART_REGISTRY` leaves, `TOOL_DISPATCH`, and the 20 tool leaves under `tools/`. (The base `ChatMessage` import has exactly three sites: `system-message.tsx`, which always passes `role: "system"`; `queued-messages.tsx`, which passes `role: "user"`; and `chat-message.stories.tsx`.)
- **Change.** After the native-thread skin lands (Phases 1–4) and the harness is green, land a no-op tripwire (`throw` at the top of the `message.role === "agent"` rendering in `ChatMessage`'s non-system branch — _not_ the whole non-system branch, which serves live user messages), run the full integration harness + `pnpm tsc-check`. If nothing throws across all recordings, delete the dead agent/tool cluster (`TOOL_DISPATCH`, the 20 tool leaves, the agent/tool `PART_REGISTRY` entries, `CollapsibleAgentActivityGroup`, and the agent-message chrome) and replace the agent-part exhaustiveness scaffolding with one ~15-line `Assert<>` mapping the agent `DBPart["type"]` keys against what `native-thread`'s `ASSISTANT_PART_COMPONENTS` handles. **Keep** `MessagePart`, `groupParts`, `ImageGroup`, the five user-part renderers, and the user-bubble chrome.
- **Phase.** Separate slice in the re-scoped Phase 7 slot — strictly AFTER Phases 1–4 are harness-green. Gated on the Phase 0 consolidation answer = "retiring."
- **Complexity delta.** Strongly subtractive, but **recount required before execution.** The −1,594-line figure from the draft counted the whole `chat-message.tsx` + `part-registry.ts` as deletable; after carving out the live user-part path (`MessagePart` ~202 lines stays, the user-part `PART_REGISTRY` entries stay, `ImageGroup` stays, the user-bubble branch of `chat-message.tsx` stays), the true delta is the `TOOL_DISPATCH` table (`tool-part.tsx`, 563 lines), the 20 tool leaves, `CollapsibleAgentActivityGroup`, and the agent-only `PART_REGISTRY` entries. Still the largest net-negative ratio in the port; the finalizer of the deletion PR must produce the exact line count against what remains live, not assert the draft's number.
- **Risk.** "Something traced as dead is live" — the exact failure this doc already hit once. Mitigated by the tripwire-then-delete sequence scoped to the `role: "agent"` path only; the harness is the gate.
- **Verification.** Tripwire `throw` on the agent path + full harness replay (nothing throws) + `tsc-check` (no live importer breaks) + a manual queued-message render (user parts still show) ; then delete and re-run all three. Tool/part `*.test.ts` and `*.stories.tsx` for deleted agent/tool leaves get deleted with them — they only ever tested the dead path. Do **not** delete tests for the surviving user-part renderers.

### I2 — Delete the `runtime-fingerprint` + `runtime-part-conversion` island — NO GATE

- **Problem.** `assistant-ui/runtime-fingerprint.ts` is imported only by `assistant-ui/runtime-fingerprint.test.ts`. `assistant-ui/runtime-part-conversion.ts` is imported only by `runtime-fingerprint.ts`. **Verified:** a repo grep for both names returns only those three files. A self-contained dead island that an audit scoped to "registry + tools" misses because it sits next to live files under `assistant-ui/`.
- **Change.** Delete both source modules and the test. No other edits — nothing else imports them.
- **Phase.** Separate subtractive slice; rides Phase 0. No gate — it is in no render path.
- **Complexity delta.** Pure removal: −2 modules (331 + 298 = 629 source lines) + 103-line test, adds nothing.
- **Risk.** Near-zero. `tsc-check` proves no dangling import; the harness is untouched.
- **Verification.** `pnpm tsc-check` + one chat vitest run.

### I3 — Make `native-thread-utils.ts` THE live view-props adapter; extend it to reasoning

- **Problem.** The pure-data→pure-view seam already exists for tools: `native-thread-utils.ts` (`toolArgsDisplayText`, `toolCallResultText`, `toolArgPreview`, `getToolGroupFlags`) turns runtime props into view-ready values, and `NativeToolCall` (`native-thread.tsx:99`) just renders them. But `NativeReasoning` (`native-thread.tsx:39`) has no such seam — it passes raw `text` + `status.type === "running"` straight into `TextPart`. A re-skin of the reasoning leaf can't happen cleanly without dragging derivation along.
- **Change.** Add `reasoningViewProps(text, status)` returning `{ body, streaming, label }` so `NativeReasoning` becomes a pure shell over nauval `Reasoning`. Add a one-line doc contract at the top of `native-thread-utils.ts`: _every value a nauval leaf needs is computed here as a plain string/boolean/number; leaves receive only these, never a runtime part._ Leave `TextPart`'s internal streaming state machine where it is.
- **Phase.** Rides Phases 1–3 directly (those phases already edit these leaves). No new slice.
- **Complexity delta.** Net neutral-to-negative: +~30-line pure function + doc comment; removes the inline `streaming` derivation duplicated across leaves; prevents someone re-deriving an adapter framework.
- **Risk.** Very low — pure functions, unit-testable in isolation. `tsc-check` unaffected (no dispatch tables touched).
- **Verification.** `native-thread.test.tsx`; adapter unit tests next to `native-thread-utils.ts`; harness replay of a run with tools + reasoning.

### I4 — Vendored-leaf purity lint rule (the one justified config addition)

- **Problem.** Today's live leaves bind to assistant-ui runtime types: `NativeToolCall: ToolCallMessagePartComponent` (`native-thread.tsx:99`), `NativeReasoning: ReasoningMessagePartComponent` (`native-thread.tsx:39`), `NativeToolGroup` calls `useAuiState`. That coupling is fine in the binding shells (Layer B) but must not leak into the vendored `components/ai/*` files (Layer A), or the vendored components stop being swappable. The port plan states the rule in prose (vendoring strategy) but does not enforce it.
- **Change.** Two-layer split: Layer A (`components/ai/*`) is pure, prop-driven, zero imports from `@assistant-ui/react`, `@terragon/*`, or any store; Layer B (`native-thread.tsx`, `chat-message-system.tsx`) keeps the runtime bindings, calls the adapter, passes plain props down. Enforce Layer A purity with one ESLint `no-restricted-imports` rule scoped to `components/ai/**`.
- **Phase.** Rides Phase 0 (vendoring); Phases 1–6 consume it.
- **Complexity delta.** **Net additive** — and justified. The vendored files exist for the port regardless; the rule (~10 lines) is the cheapest enforcement that keeps the next re-skin touching only Layer A. The alternative (vendored files reaching into runtime) is strictly worse.
- **Risk.** Low — mechanical lint rule.
- **Verification.** A throwaway Ladle story renders a Layer-A component with hand-written plain props and no provider; if it renders, the boundary is clean. `tsc-check` for prop-shape conformance.

### I5 — Reuse the existing `@theme inline` alias seam (do NOT build a parallel token set)

- **Problem.** The plan budgets a Phase-0 "map nauval semantic tokens onto Terragon tokens" step as greenfield. It is not. `globals.css` already registers `--color-surface-soft`, `--color-error`/`--color-success`/`--color-warning`/`--color-info`, `--color-border`, `--color-muted-foreground`. The live leaves already use them (`native-thread.tsx:68` `bg-surface-soft`, `:69` `border-error/40`). nauval's `text-muted-foreground` / `border-border` / `text-destructive` already resolve or are one alias away.
- **Change.** Phase 0 does a mapping _audit_, not a token-creation pass. Each nauval token either already resolves (no action) or needs a one-line `@theme inline` alias following the existing pattern (e.g. `--color-surface: var(--card)`). Record the ~3–6 aliases actually needed in `VENDOR.md`. Skip diff/markdown tokens (diff stays bespoke, streamdown stays).
- **Phase.** Phase 0 — shrinks it.
- **Complexity delta.** Strongly negative vs. the plan's implied scope: ~3–6 `var()` aliases instead of a token system. No `:root`/`.dark` duplication — aliases point at tokens that already carry light+dark values.
- **Risk.** Very low. Tailwind v4 emits nothing for an unregistered token, so a missing alias is a visual no-op, not a crash.
- **Verification.** Render `Tool`/`Message`/`Status` in a Ladle story in both `:root` and `.dark`; eyeball that surfaces match today's cream-card look.

### I6 — Retarget the chrome-light live set onto existing Radix; adopt Base UI for nothing in base scope

- **Problem.** `apps/www/package.json` has 18 `@radix-ui` packages and zero `@base-ui`. nauval primitives sit on Base UI. Adopting them wholesale adds a parallel primitive stack with diverging a11y/focus/portal behavior.
- **Change.** The base-scope live surfaces are chrome-light: `Tool`/`ToolGroup`/`Reasoning` are `<details>` today (no primitive needed); `Message`/`Status`/`Callout` are divs+spans. The only real primitives appear in the composer (Phase 5) and meta-chip tooltips (Phase 6, where Radix `Tooltip` already exists). Retarget every base-scope nauval primitive onto existing Radix or keep `<details>`; do not add `@base-ui` at all unless one component proves expensive to retarget — record that single exception in `VENDOR.md` if it ever happens.
- **Phase.** Phase 0 (the plan already makes this a blocking decision; this resolves it subtractively).
- **Complexity delta.** Strongly negative — zero new primitive packages for base scope vs. a whole second stack.
- **Risk.** Low for the live set (mostly `<details>`). The Base-UI-heavy components (`Confirmation`, `FileTree`, `Todo`) are all on the dead **agent/tool** path that I1 deletes — confirm that during the I1 deletion, since I1's scope is now narrower than the draft assumed.
- **Verification.** Per-component Ladle check: keyboard open/close, focus-visible ring, dark mode.

### I7 — Hoist `SystemMessage`'s `getLabel`/`getDotClassName` to module scope before skinning

- **Problem.** `SystemMessage` defines `getLabel` and `getDotClassName` as closures inside the component (`chat-message-system.tsx`), each a `switch` guarded by `_exhaustiveCheck: never`. When Phase 4 swaps the dot+row chrome for nauval `Status`/`Callout`, a careless edit risks moving the label/color logic into the vendored presentational component, re-coupling data to presentation and putting the `never` guard inside a file the next re-skin overwrites.
- **Change.** Hoist both to module-level pure functions taking the `message` union, keeping the two `never` guards exactly where they are (no behavior change). The Phase-4 leaf becomes a pure `Status`/`Callout` shell receiving `{ label, tone }`.
- **Phase.** Folded into Phase 4 (not a separate slice).
- **Complexity delta.** Neutral (moves two closures to module scope). The value is preserving the exhaustiveness guard on the data side and keeping the nauval leaf pure.
- **Risk.** Low — the `never` guards make any missed `message_type` a compile error.
- **Verification.** `tsc-check`; harness replay of a run emitting retry/compact/clear-context notices. Do not touch the `git-diff` branch or the `stop` early-return.

### I8 — Narrow the live system path off the `messagePartProps`/`toolProps` bag (single named cleanup)

- **Problem.** `terragon-thread-runtime-content.tsx` builds two memoized prop bags (`messagePartProps`, `toolProps`) every render. The one live **system** consumer, `TerragonSystemMessage` (`system-message.tsx`), uses exactly `onOpenRepoFile` out of the entire bag — it reaches it through `ChatMessage`'s system branch (`chat-message.tsx:108`). **Claim correction:** the bag is _not_ "reachable only from the dead path." It also flows into the live user-part `MessagePart` render — `chat-message.tsx:159` spreads `{...messagePartProps}` into `MessagePart`, which is live for queued user messages. So the rewire below is sound, but it does **not** unlock full deletion of the bag; the bag survives I1 because the live user-part path still consumes it.
- **Change.** Give `TerragonSystemMessage` `onOpenRepoFile` directly from `useTerragonThread()` context (it is already a top-level context field) instead of reaching through the bag in `ChatMessage`'s system branch. This decouples the live system path from the bag cleanly. The bag's full removal is deferred (see "Deferred / separate slice").
- **Phase.** Rides Phase 4 (already in `chat-message-system.tsx`). Do NOT attempt the full bag deletion during the port.
- **Complexity delta.** Net-neutral during the port (one prop rewire). The bag's eventual removal is a separate slice gated on re-pointing the user-part render path, not on I1.
- **Risk.** Low-medium. The git-diff inline comment widget depends on `onOpenRepoFile` reaching `GitDiffPart` — verify it still arrives after the rewire.
- **Verification.** git-diff system message still renders and "open repo file" still works (harness replay of a git-diff-emitting run); `tsc-check`.

### I9 — Add the missing safety net for the LIVE surface (stories + one harness assertion)

- **Problem.** The port re-skins `native-thread.tsx`, which today has **one** test (`native-thread.test.tsx`, asserting grouping/text, not visual states) and **zero** stories. All 19 chat `*.stories.tsx` target the dead path. The exhaustiveness guards the plan trusts fence the dead `PART_REGISTRY`/`tool-part` surface, **not** the live `NativeToolCall` state branches — a re-skin that drops the `failed` branch compiles clean and passes `part-registry.test.ts`. The verification baseline names artifacts that don't cover the surface being changed.
- **Change.** Add one `native-thread.stories.tsx` with fixtures for the states Phases 1–3 re-skin (streaming text; reasoning open + streaming; tool call in running/failed/done; collapsed grouped run with a failure). Add ~2 DOM-shape assertions to the already-mounting `chat-ui-streaming-budget.test.tsx` (the only integration test that mounts real `ChatUI` + `NativeThread` end-to-end): after a tool call, assert the tool name + a `<details>`; after a failing tool, assert the failure label renders. Use text/role assertions, never `toHaveClass`.
- **Phase.** Story rides Phase 0 (must precede Phase 1); harness assertion rides Phase 3 (wire as pending in Phase 0, satisfy in Phase 3).
- **Complexity delta.** Additive but minimal (+1 story file ~120 lines, +~10 test lines) and justified: it is the only visual gate for the highest-leverage live phases, and it replaces the plan's reliance on manual scroll/smoke testing.
- **Risk.** Low (additive, no production code).
- **Verification.** Story renders all four states in Ladle; the new harness assertion fails on `main` if the tool card is removed and passes after Phase 3; `tsc-check` stays green.

---

## Sequencing against the port's seven phases

```
Phase 0 ── I2 (delete fingerprint island, NO gate)
        ── I4 (vendored-purity lint rule)
        ── I5 (theme alias audit)         } all gate-free, do first
        ── I6 (retarget onto Radix)
        ── I9a (native-thread.stories.tsx, BEFORE Phase 1)
        ── [GATE QUESTION asked here → answer drives I1 below]

Phases 1–3 ── I3 (extend native-thread-utils.ts to reasoning) rides these edits
           ── I9b (harness DOM assertion satisfied in Phase 3)

Phase 4    ── I7 (hoist getLabel/getDotClassName)
           ── I8 (narrow live system path to onOpenRepoFile via context)

Phase 7    ── I1 (DELETE dead AGENT/TOOL path) — re-scoped from "skin" to "delete"
              REQUIRES: Phases 1–4 harness-green AND Phase 0 gate = "retiring"
              SCOPE:    agent/tool branch only — KEEP the live user-part path
              SEQUENCE: skin native → prove harness → tripwire throw (agent path) → delete
```

**Must-precede constraints:**

- **I9a before Phase 1.** Without the live-surface story, Phases 1–3 ship blind — there is no visual diff target for the tool/reasoning re-skin.
- **Phases 1–4 (skin) before I1 (delete).** Order is: skin native → prove harness → tripwire → delete. If the skin reveals a part type the native transcript doesn't yet handle, surface it as a native-thread gap to fill, not masked by deleting its fallback prematurely.
- **I3 before/with Phase 3.** The reasoning adapter wants to exist before `NativeReasoning` is re-skinned, so the leaf is already a pure shell.

**Gated on the Phase 0 consolidation owner's answer:**

- **I1 (delete dead agent/tool path)** fires only if the gate returns "retiring." Nothing routes **agent** messages through the legacy renderer today, but the gate owner makes it official, because deletion forecloses any future consolidation surface that might re-mount `ChatMessage` with agent messages. The live **user-part** path is independent of this gate and is never deleted.
- **I2, I3, I4, I5, I6, I7, I8, I9** are all gate-independent.

**Gate-free immediate wins (no consolidation answer needed): I2 + I4 + I5 + I6 + I9a ≈ −629 lines / −2 files plus the entire Phase-0 simplification, before any skinning begins.**

---

## Deferred / separate slice (safer after the port)

- **Option B — route live tool parts through `TOOL_DISPATCH`.** One lens argues it is a ~30-line projection call site reusing the hydration path's existing projection; another argues it re-couples the live hot path to the agent normalizer and resurrects 20 leaves into the render path. Both can be right: the _adapter_ is small, but its _consequence_ (per-tool richness in the live transcript — bash exit codes, ANSI, inline diffs) is a product feature, not a unification step. Keep it out of the cosmetic port entirely. If product wants that richness, scope it as a separate slice built fresh against `NativeToolCall`, and resolve the cost disagreement there with a spike.
- **Full deletion of the `messagePartProps`/`toolProps` bag + its `memo` comparators.** Not unlocked by I1: the bag still flows into the live user-part `MessagePart` render (`chat-message.tsx:159`). Removing it requires first re-pointing the queued-user-message render path off `ChatMessage` (or threading the few props it needs directly). Do I8's narrow rewire during the port; defer the ~80-line bag removal to the slice that re-points the user-part path.
- **Secondary-panel body renderers → nauval (`FileTree`/`CodeBlock`/`Player`/`GeneratedImage`).** The port plan already scopes the panel to tab-strip chrome only; adopting the body renderers is its own slice with its own verification.

---

## YAGNI guardrails ("do NOT do")

- **Do NOT build a presentation-adapter framework.** No registry of adapters, no context, no typed dispatch over part kinds. The codebase needs ~30 lines of new pure functions (I3) and one ESLint rule (I4). `native-thread-utils.ts` + the `@theme inline` aliases ARE the seam; name and extend them, do not abstract over them.
- **Do NOT add a runtime-exhaustiveness guard for native tool-call states.** The state set is three values (`running`/`error`/`success`) checked once. A story covering the three states (I9) catches the same regression more cheaply than mirroring the dead-path dispatch machinery onto a surface that doesn't need it.
- **Do NOT split `TextPart`'s `processTextForRendering` / streaming state machine into the adapter file.** That logic is stateful streaming detection with `useRef` continuity, not stateless view-shaping. Pulling it into a "pure adapter" either breaks the streaming-append fast path or forces the adapter to carry React refs. The adapter boundary is for stateless derivations only.
- **Do NOT add a second, nauval-namespaced token block.** Two color-token systems is the same "second primitive stack" mistake as Base UI, applied to color. Alias onto the canonical tokens; never duplicate the palette.
- **Do NOT vendor Base UI for fidelity to upstream nauval.** Fidelity to upstream is worthless here; fidelity to the app's existing Radix a11y/focus behavior is what matters. Retarget aggressively.
- **Do NOT touch the DB data model when deleting renderers.** Every part type stays in `db-message.ts` and the `ui-messages.ts` union — read-side must tolerate unknown variants (AGENTS.md rule). Retire the _renderers_, never the _schema_. When removing a registry/dispatch key, remove its union member in the same change or the `Assert<>` guards break the build — that failure is the safety net; never weaken it to "make the build pass."
- **Do NOT delete the bag (`messagePartProps`/`toolProps`) or its comparators during the port.** It is load-bearing for both the dead agent path and the **live** user-part render. Narrow the one live system consumer (I8); defer the bag's removal (see "Deferred").
- **Do NOT delete the live user-part path under I1.** `MessagePart`, `groupParts`, `ImageGroup`, the five user-part `PART_REGISTRY` renderers, and the user-bubble chrome are reachable live through `QueuedMessages`. I1 deletes the **agent/tool** branch only.
- **Do NOT chase atom consolidation, HTML snapshot tests, or "symmetry" stories for dead leaves.** Only three chat files use jotai and none declare local atoms — there is no atom cleanup to ride. HTML snapshots churn on every re-skin phase and train reviewers to bless diffs blindly. Backfilling stories for dead leaves polishes a surface I1 deletes.

# The simple architecture: one vocabulary, one fold, one registry

**Date:** 2026-07-03 · **Author:** session architect (Fable) · **Status:** plan of record for the simplification pass; refines `2026-07-03-provider-events-to-nauval-rendering-spec.md` §3-4.
**Prime directive (Tyler):** make it super simple, so adding features is easy. Native Claude/Codex-app feel.

## The fitness test

Adding a new renderable agent event (say Codex ships `item.sketch`) must cost exactly three edits:

```
1. daemon   provider adapter: one entry  (codex event → TerragonPart variant)
2. client   fold: one case               (TerragonPart → TranscriptItem kind)
3. client   registry: one line + leaf    (kind → nauval component)
```

Zero server edits. Zero schema migrations. Three co-located tests. If a change costs more than this, the architecture has failed and the fix is to the architecture, not the feature.

## The four layers (and what each is forbidden to do)

**Providers (Tyler, 2026-07-03): Claude and Codex ONLY.** Gemini, amp, and opencode are removed — new dispatch is `claudeCode | codex`; historical threads with other agent values stay readable. This unblocks deleting the entire legacy stream-json transport (gemini was its last tenant): two transports remain, claude-acp and codex-app-server (+codex-via-acp).

```
①  PROVIDER ADAPTERS (packages/daemon)
    codex-app-server | claude-acp  →  AG-UI events + terragon.part
    One normalization point. Table-shaped: eventKind → builder.
    Forbidden: business logic, retry policy, rendering hints.

②  THE PIPE (server: ingest → agent_event_log → SSE)
    Generic. Typed at the envelope, agnostic to part payloads.
    auth → fence → validate(write-time) → persist ∥ publish → project
    Forbidden: switching on part kinds (projections use the shared
    converter table, which lives with the schema, not the route).

③  TRANSCRIPTSTORE (client)
    One pure fold: AG-UI envelope → TranscriptItem[].
    Owns: identity, ordering, streaming assembly, dedupe, hydration.
    Forbidden: rendering, fetching, timers (coalescing stays outside).

④  LEAF REGISTRY (client)
    TranscriptItem.kind → nauval component. One exhaustive map over a
    CLOSED union with a compile-time never-check.
    Forbidden: state, data massaging (fold's job), assistant-ui.
```

Supporting state, deliberately small: the **status machine** (thread lifecycle), the **optimistic overlay** (the only client write layer), **meta-chips channel** (separate by design). Everything else goes.

## The vocabulary (layer ①→②ʼs contract): AG-UI, directly

**Decision (Tyler, 2026-07-03): there is no separate Terragon event union.** The log already persists AG-UI envelopes; the "canonical event" layer exists only in the daemon→route hop and is a translation tax. End state: **adapters emit AG-UI events directly.**

- lifecycle: `RUN_STARTED`, `RUN_FINISHED`/`RUN_ERROR` — operational fields (`recoverable{kind,retryAfterMs}`, usage) ride the events' passthrough fields (the pinned @ag-ui/core schemas are zod passthrough)
- content: `TEXT_MESSAGE_*`, `REASONING_*` deltas under stable identities (W-ID holds)
- tools: `TOOL_CALL_START/ARGS/END/RESULT`
- **`terragon.part{richKind, payload}`** — ONE typed extension event (CUSTOM name fixed forever). The richKind payload union (plan/diff/terminal/image/audio/resource-link/auto-approval/permission/error/compaction/web-search/sub-agent…) IS the extension point. Zod-versioned, read-tolerant.
- meta: `ThreadMetaEvent` (separate channel, unchanged)

**Why not Vercel AI SDK or TanStack AI as the event pattern** (evaluated 2026-07-03): both are client-side chat SDKs for model→UI streaming — neither models runs, terminal fencing, seq-cursor replay, or server-authoritative resume, which is what Terragon's pipe IS. Adopting one re-imports an assistant-ui-shaped runtime dependency immediately after deleting one, and swaps our pinned AG-UI churn risk for theirs (AI SDK v4→v5 was a hard break). AG-UI stays: it's already the persisted format, and the client fold is ours either way.

Rules that keep it simple:

1. **New content = new richKind.** Never a new AG-UI event name, never a new wire channel. Unknown richKinds pass through the pipe untouched and fold to an `unknown-part` TranscriptItem (labeled fallback card — nothing is ever silently invisible again).
2. **The middle layers die.** ClaudeMessage (Anthropic-shaped parse target) and the canonical-event wrapper (daemon→route hop) both collapse in S5: adapters build AG-UI rows + terragon.part payloads directly; the ag-ui-mapper's job moves into the adapters. ClaudeMessage survives only inside the legacy gemini transport until Tier-4 unblocks.
3. **The pipe never learns new types.** Write-time validator is structural (lifecycle pairing), not kind-aware. DBMessage projection uses the shared converter table keyed by richKind, co-located with the payload union — adding a richKind that needs DB projection is one entry in THAT table, still zero route edits.

## The client (layers ③→④)

**TranscriptStore** (P2, in flight — this section is its contract):

- `fold(state, envelope) → state`, pure, exhaustive over the AG-UI vocabulary + `terragon.part` payloads. Unknown → `unknown-part` item, never dropped.
- `TranscriptItem` is a CLOSED union: `text · reasoning · user · tool · terminal · diff · plan · permission · sources · delegation · image · attachment · error · transient-retry · compaction · unknown-part`. Kinds map 1:1 to the rendering-spec table. Each item: stable identity, seq, status.
- Store: `useSyncExternalStore`-compatible, per-item version counters (leaf re-renders stay per-item under streaming; the bit-packed selector trick ports here).
- Hydration and live are THE SAME fold over the same envelopes (`?history=messages` output = persisted envelopes). No adapter seam, no merge strategies, no `historyLoadKey` generations — the fold is idempotent by (runId,eventId) so replay/live overlap is a non-event.

**Leaf registry:**

```ts
const LEAF: { [K in TranscriptItem["kind"]]: FC<ItemProps<K>> } = {
  text: TextLeaf,            // Message + streamdown
  reasoning: ReasoningLeaf,  // Reasoning / ChainOfThought
  tool: ToolLeaf,            // Tool (+Task receipt line)
  terminal: TerminalLeaf,    // Tool shell + custom body
  diff: DiffLeaf,            // Diff + useDiff
  plan: PlanLeaf,            // Todo
  permission: PermissionLeaf,// Confirmation
  sources: SourcesLeaf,      // Source/Citation
  ...
};
```

A `Record` over a closed union IS the exhaustiveness check — a new kind fails compile until its leaf exists. This is not the banned dispatch tree: that was open string dispatch into 14k LOC of bespoke branches; this is a typed total function into prop-driven nauval leaves. AGENTS.md gets updated to say exactly that.

**What gets deleted when this lands** (the simplification dividend):
`@assistant-ui/react` + the patched `react-ag-ui` fork + patch file, the ThreadHistoryAdapter seam + merge strategies + load generations, `native-thread.tsx`'s primitive wiring + `native-thread-utils` adapters (fold absorbs), the view-model reducer's transcript half (`toUIMessages` path, side-panel message copy re-sourced from the store), the TanStack transcript collection, `verifyEvents` throw-string pinning tests, two of the four client message stores. Net: the transcript pipeline becomes ~3 files a new contributor can read in an hour.

## Feature recipes (write these into AGENTS.md when P4 lands)

- **New agent event** → the three-edit recipe above.
- **New meta chip** → ThreadMetaEvent kind + chip component (2 edits, unchanged).
- **New agent provider** → one daemon adapter file (provider events → TerragonEvents) + registry entry for dispatch. Nothing else — the pipe, store, and leaves are provider-blind.
- **New feel polish** → leaf-local (components own their motion; reduced-motion via the global block).

## Staging (updates the spec's P-phases)

```
S0 = P0 protocol fixes (running)         S1 = P1 vendor nauval set (running)
S2 = P2 TranscriptStore (running; conform to the contract above)
S3 = P3 leaf registry + flagged cutover; delete assistant-ui + fork (P4)
S4 = P5 new surfaces via the three-edit recipe — each one proves the recipe
S5 = adapters emit TerragonEvents directly; ClaudeMessage dies (daemon-internal;
     gated on the legacy transport's death, independent of the client)
```

Gate for S3: the P2 equivalence assertions + the integration harness + the emulator's scenario runs (default, long-stream, rate-limit, stop) all green on the store path with the flag on.

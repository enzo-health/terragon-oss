# patches/

Local `pnpm` patches applied on install, registered in the root `package.json`
under `pnpm.patchedDependencies`.

## `@assistant-ui__react-ag-ui@0.0.26.patch`

Forks `@assistant-ui/react-ag-ui`'s runtime core to add four options the stock
package does not expose:

- `externalMessagesStrategy` — adds a `"merge-after-local-mutations"` mode that
  keeps locally appended messages when external (server) history is applied,
  instead of the stock behavior of always replacing.
- `historyLoadKey` — keys `__internal_load()` so a changed key forces a fresh
  history load generation rather than returning the cached load promise.
- `waitForInitialLoad` — `append`/`startRun` await the initial history load so a
  submit issued before hydration completes is not dropped or misordered.
- `targetMessageId` routing — text/tool-call stream updates emit against an
  explicit assistant message id, so streaming deltas land on the right message
  when several are in flight.

### Why the fork exists

Stock `@assistant-ui/react-ag-ui` only supports `externalMessagesStrategy`
`"replace"`, has no load-generation concept, and does not gate appends on the
initial load. Terragon needs merge-after-local-mutations (optimistic user
messages must survive server history application), load-generation keying (thread
switches must not serve a stale load), initial-load gating, and parent-message
routing for concurrent streams. None of these are configurable upstream, so the
compiled `dist/` is patched directly.

### Upgrade procedure

An upgrade is not a version bump alone — the patch must be ported:

1. Bump the version and re-create the patch against the new `dist/`, re-applying
   the four additions above.
2. Run the replay integration harness at `apps/www/test/integration/`.
3. Verify all four options still take effect end-to-end (merge strategy,
   load-key regeneration, initial-load gating, per-message streaming).

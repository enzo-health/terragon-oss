# AI Slop Scan

Run id: `20260426-215106-smooth-runtime-simplify`

Scope: current Terragon worktree. `jscpd` and `jsm` were unavailable locally, so this pass used bounded `rg` scans plus targeted reducer inspection.

## Accepted Cleanup

- `apps/www/src/components/chat/thread-view-model/reducer.test.ts`
  - Extracted two reducer test harness helpers:
    - `applyAgUiEvent`
    - `applyRuntimeEvent`
  - Removed repeated event envelope literals from the reducer replay tests.
  - Net code delta: `106 insertions(+)`, `141 deletions(-)`, 35 source lines removed.

## Remaining Slop, Not Changed In This Pass

- Broad `as any` use remains in existing test and provider seams. This pass did not touch it because many instances reach private internals or third-party SDK shapes and need dedicated harnesses.
- Unknown-input rich part parsing still has small repeated field guards. Kept explicit for readability because the production abstraction candidate saved too little.
- Legacy delivery-loop references are retained only in guardrail or compatibility naming from the rewrite branch; no new delivery-loop coupling was introduced by this pass.

## Rejected Candidates

- Collapsing production string membership validators in `reducer.ts`: reverted because it either increased LOC or traded a tiny savings for a generic helper at a sensitive parser boundary.
- Reworking daemon test casts: rejected because it needs a separate test harness design.
- Generic object/string/number field readers: rejected because explicit parsing code is clearer at this size.

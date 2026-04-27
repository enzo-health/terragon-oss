# Duplication Map

## Candidate ISO-001: reducer test event wrapper helpers

- Path: `apps/www/src/components/chat/thread-view-model/reducer.test.ts`
- Clone type: Type II parametric clone
- Shape: repeated calls to `threadViewModelReducer(state, { type: "ag-ui.event" | "runtime.event", event })`.
- Lever: L-EXTRACT
- LOC saved: 35 source lines in the code file, with `106 insertions(+)` and `141 deletions(-)`.
- Confidence: 5, because the helper is test-only and forwards the exact same event envelope into the same reducer.
- Risk: 1, because production code is untouched and the reducer suite covers the edited call sites.
- Score: high.
- Decision: ACCEPT.

## Rejections

- Production string-membership validator collapse in `reducer.ts`: rejected and reverted. The first version increased LOC, and the tighter rest-parameter version saved too little to justify the extra generic helper at a parsing boundary.
- Large daemon test `as any` cleanup: rejected for this pass. The tests reach private internals; removing those casts safely needs a real public test harness first.
- `getObjectField` / `getStringField` / `getNumberField` extraction: rejected for now. The repeated shape is small, and the explicit checks are clearer at the unknown-input boundary.

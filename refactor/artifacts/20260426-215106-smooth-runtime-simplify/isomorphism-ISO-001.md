# ISO-001: reducer test event wrapper helpers

## Equivalence Contract

- Inputs covered: AG UI and runtime `BaseEvent` objects passed through reducer tests.
- Mapping: `applyAgUiEvent(state, event)` calls `threadViewModelReducer(state, { type: "ag-ui.event", event })`; `applyRuntimeEvent(state, event)` calls `threadViewModelReducer(state, { type: "runtime.event", event })`.
- Ordering preserved: yes. Each helper is synchronous and wraps one reducer call at the original call site.
- Tie-breaking: unchanged / N/A.
- Error semantics: unchanged. Exceptions, if any, still come from the same reducer invocation.
- Laziness: unchanged / N/A.
- Short-circuit eval: unchanged / N/A.
- Floating-point: N/A.
- RNG / hash order: N/A.
- Observable side-effects: unchanged. Reducer inputs and outputs are identical at the call boundary.
- Type narrowing: unchanged. The helper accepts the same `BaseEvent` shape the tests already passed to the reducer envelope.
- Rerender behavior: unchanged / N/A. This is test harness code only.

## Verification

- Baseline: `pnpm -C apps/www test src/components/chat/thread-view-model/reducer.test.ts --run` passed, 22 tests.
- After: `pnpm -C apps/www test src/components/chat/thread-view-model/reducer.test.ts --run` passed, 22 tests.
- After: `pnpm -C apps/www tsc-check` passed.
- After: `pnpm -C apps/www lint` passed.
- After: `git diff --check` passed.

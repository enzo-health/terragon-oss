# Autoresearch: Delivery Loop v3 State Machine

## Goal
Improve the v3 delivery loop state machine across three dimensions:
1. **Reduce stuck-state risk** — minimize silent no-ops that hide missing handlers
2. **Improve test coverage** — maximize passing tests, add missing edge cases
3. **Improve effect drain reliability** — ensure effects execute promptly

## Metric
**Composite score** (lower is better):
- `gap_count × 10` — silent no-op handlers in reducer
- `failed_tests × 100` — test failures are bugs
- `passed_tests × -1` — reward more coverage

## Files in Scope
- `apps/www/src/server-lib/delivery-loop/v3/reducer.ts` — state machine core
- `apps/www/src/server-lib/delivery-loop/v3/reducer.test.ts` — reducer unit tests
- `apps/www/src/server-lib/delivery-loop/v3/reachability.test.ts` — exhaustive transition matrix
- `apps/www/src/server-lib/delivery-loop/v3/invariants.test.ts` — property-based invariant tests
- `apps/www/src/server-lib/delivery-loop/v3/process-effects.ts` — effect handlers
- `apps/www/src/server-lib/delivery-loop/v3/process-effects.test.ts` — effect handler tests
- `apps/www/src/server-lib/delivery-loop/v3/kernel.ts` — event append + drain
- `apps/www/src/server-lib/delivery-loop/v3/types.ts` — state/event type definitions

## Constraints
- Do NOT change the 10 state types or 18 event types (breaking change)
- Do NOT change kernel transaction semantics
- All changes must pass `pnpm tsc-check`
- All v3 tests must pass after each change

## Command
```bash
./autoresearch.sh
```

## What's Been Tried
(updated every 5 runs)

### Baseline
- Run #1: baseline measurement

## Ideas Queue
See `autoresearch.ideas.md`

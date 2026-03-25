# Autoresearch Ideas Queue

## High Impact (next experiments)
- [ ] Gate staleness requeue max retries — add cap (50 requeues = ~4hrs), emit gate_ci_timeout
- [ ] effectResultToEvent exhaustiveness check — TypeScript never-type guard for unmapped outcomes
- [ ] dispatch_sent guard: reject if activeRunId already set to different runId (replay protection)
- [ ] Add effect emission verification to reachability matrix (already partially done — verify completeness)

## Medium Impact
- [ ] Lease expiry exponential backoff for stale reclaims
- [ ] eagerDrain failure structured logging with effect kind
- [ ] Terminal state early-return in invariant middleware (skip for done/stopped/terminated)

## Already Done (this session)
- [x] gating_ci run_failed handler
- [x] dispatch_acked edge case tests (6 tests)
- [x] Terminal state absorption tests (4 tests)
- [x] Budget exhaustion tests (2 tests)
- [x] Global handler tests (2 tests)
- [x] Effect handler edge case tests (3 tests)
- [x] Awaiting state handler tests (5 tests)
- [x] Property-based invariants (3 tests)
- [x] gate_staleness_check version fix (use head.version in catch)
- [x] Recursive drain prevention (eagerDrain: false in executeStateBlockingEffect)
- [x] Remove redundant triple drain in daemon-event route

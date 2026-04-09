# User Testing Guide: Legacy-Dead-Flaky-Removal

## Overview

This document captures testing knowledge for the legacy-dead-flaky-removal milestone validation.

## Services

- PostgreSQL: localhost:5432 (terragon-db container)
- Redis: localhost:6379 (terragon-db container)

## Testing Tools Available

### 1. CLI Testing via `pnpm delivery-loop:local`

- `pnpm delivery-loop:local preflight` - Readiness check
- `pnpm delivery-loop:local snapshot --workflow-id <id>` - Diagnostics
- `pnpm delivery-loop:local snapshot --thread-id <id>` - Thread diagnostics
- `pnpm -C apps/www exec vitest run` - Unit tests

### 2. Database Access

- Direct DB access via Drizzle ORM
- Test fixtures can be created via scripts in packages/shared

## Validation Concurrency

- **API surface**: 3 concurrent validators max
- **Process surface**: 2 concurrent validators max
- **CLI surface**: 1 concurrent validator max (sequential commands)

## Flow Validator Guidance: API/Process Surface

### Isolation Boundaries for VAL-CROSS-006

**Test**: Post-terminal ingress cannot mutate workflow or PR linkage

**Approach**:

1. Use existing database fixtures or create isolated test workflow/thread records
2. Drive workflow to terminal state via API replay or direct state manipulation
3. Replay ingress events (daemon/webhook/human) against terminal workflow
4. Verify no state mutation occurs

**What to Avoid**:

- Do not test against production workflows
- Do not create fixtures that could interfere with parallel test runs
- Use isolated workflow/thread IDs with unique prefixes

**Evidence Collection**:

- Diagnostics snapshots before/after ingress replay
- State diffs showing no mutation occurred
- PR linkage stability verification

## Assertion: VAL-CROSS-006

**Requirement**: After terminalization, additional daemon/webhook/human ingress cannot mutate workflow state or PR linkage.

**Tool**: `vitest` route tests + workflow diagnostics

**Evidence Needed**:

1. Workflow in terminal state (done/stopped/terminated)
2. Replay duplicate ingress (daemon events, webhook deliveries)
3. Capture diagnostics showing stable terminal state
4. Verify no mutating events appended
5. Verify PR linkage remains stable

**Test Command**:

```bash
pnpm -C apps/www exec vitest run src/server-lib/delivery-loop/v3/reducer.test.ts
pnpm -C apps/www exec vitest run src/app/api/daemon-event/route.test.ts
pnpm -C apps/www exec vitest run src/app/api/webhooks/github/route.test.ts
```

**Success Criteria**:

- All tests pass
- No regression in terminal absorption behavior
- Post-terminal ingress returns appropriate no-op/dedup responses

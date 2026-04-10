# User Testing Guide: Delivery Loop Validation

## Overview

This document captures testing knowledge for delivery loop milestone validations, including legacy-dead-flaky-removal and end-to-end-hardening.

## Environment Requirements

### Critical Environment Variables for Web Service

The web service (`apps/www`) requires the following environment variables to start:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `NEXT_PUBLIC_GITHUB_APP_NAME`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`

**Without these, the web service will fail to start.** This affects UI testing that requires browser automation.

### Workaround for UI Testing

When web service cannot start:

1. Use vitest unit tests for UI logic validation where possible
2. Use `agent-browser` against external staging environment if available
3. Mark UI assertions as "blocked" due to missing environment prerequisites

## Validation Concurrency

- **API surface**: 3 concurrent validators max
- **Process surface**: 2 concurrent validators max
- **CLI surface**: 1 concurrent validator max (sequential commands)
- **Browser/UI surface**: 1 concurrent validator max (requires full web stack)

## Services

- PostgreSQL: localhost:5432 (terragon-db container)
- Redis: localhost:6379 (terragon-db container)
- Web (requires env vars): localhost:3100

## Testing Tools Available

### 1. CLI Testing via `pnpm delivery-loop:local`

- `pnpm delivery-loop:local preflight` - Readiness check
- `pnpm delivery-loop:local snapshot --workflow-id <id>` - Diagnostics
- `pnpm delivery-loop:local snapshot --thread-id <id>` - Thread diagnostics
- `pnpm -C apps/www exec vitest run` - Unit tests

### 2. Database Access

- Direct DB access via Drizzle ORM
- Test fixtures can be created via scripts in packages/shared

### 3. Browser Testing via `agent-browser`

- Requires web service running on port 3100
- Preferred tool: `agent-browser` skill
- Fallback: Playwright

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

## Flow Validator Guidance: Browser Surface

### Isolation Boundaries for UI Testing

**Prerequisites**:

- Web service must be running on port 3100
- Valid test user credentials
- Isolated thread/workflow for each test

**Test Approach**:

1. Create isolated test thread via API
2. Navigate to thread page in browser
3. Observe delivery-loop status UI
4. Trigger state transitions via API
5. Verify UI reflects changes

**What to Avoid**:

- Do not use production threads
- Do not test against shared staging data
- Clean up test threads after completion

**Evidence Collection**:

- Screenshots of UI states
- Status payload captures
- Network trace showing refresh behavior

## Flow Validator Guidance: Cross-Area Surface

### VAL-CROSS-001: End-to-end task-to-PR lifecycle

**Daemon-event test auth path (non-production only)**:

- `/api/daemon-event` now accepts test-context auth when all headers below are present:
- `X-Terragon-Test-Daemon-Auth: enabled`
- `X-Terragon-Test-User-Id: <target-user-id>`
- `X-Terragon-Secret: <INTERNAL_SHARED_SECRET>`
- This path is disabled in `NODE_ENV=production` and does not replace token auth when `X-Daemon-Token` is supplied.

**Test Approach**:

1. Start with CLI `delivery-loop:local e2e` for the framework path
2. Verify success payload contract
3. Check browser for UI confirmation (if web available)
4. Collect diagnostics snapshot

**Evidence Needed**:

- E2e success JSON with threadId/workflowId/githubPrNumber
- Workflow diagnostics snapshot
- UI screenshot (if available)

### VAL-CROSS-007: API and browser state consistency

**Test Approach**:

1. Sample API status at multiple lifecycle phases
2. Capture browser state at same phases
3. Compare semantics match

**Evidence Needed**:

- Paired captures showing matching state
- Status payloads from API
- UI state captures from browser

## Assertion Reference

### Assertion: VAL-CROSS-006

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

### End-to-End Hardening Assertions (VAL-UI-001..006, VAL-CROSS-001, VAL-CROSS-007)

**UI Assertions** (VAL-UI-001..006):

- Tool: `agent-browser` (preferred) or Playwright fallback
- Requires web service running
- Tests phase mapping, blocked states, terminal states, PR linkage, refresh behavior

**Cross Assertions**:

- VAL-CROSS-001: CLI e2e + browser verification
- VAL-CROSS-007: Paired API/browser captures

**Evidence Format**:

- Screenshots showing UI state
- API status payloads
- Network traces for refresh behavior

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

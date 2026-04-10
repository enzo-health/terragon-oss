# QA Validator Module

Quality assurance system for validating Leo task consistency across UI, database, and container states.

## Purpose

This module detects discrepancies between:

- **UI state** (what users see in the web interface)
- **Database state** (ground truth in PostgreSQL)
- **Container state** (actual sandbox execution)

When sources disagree, it generates structured bug reports indicating where the system is lying to users.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    QA VALIDATOR                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ UI Source    │  │ Database     │  │ Container    │     │
│  │ Fetcher      │  │ Fetcher      │  │ Fetcher      │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │             │
│         └──────────────────┼──────────────────┘           │
│                            ▼                               │
│                   ┌──────────────┐                          │
│                   │ Comparator   │                          │
│                   │ Engine     │                          │
│                   └──────┬───────┘                          │
│                          ▼                                 │
│                   ┌──────────────┐                          │
│                   │ Discrepancy  │                          │
│                   │ Reports      │                          │
│                   └──────────────┘                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## CLI Commands

### `terry qa verify <thread-id>`

Run a one-time validation of a thread's consistency.

```bash
# Basic validation
terry qa verify thread_abc123

# Deep validation with event journal
terry qa verify thread_abc123 --deep

# JSON output for scripting
terry qa verify thread_abc123 --json

# Exit with error if issues found
terry qa verify thread_abc123 --fail-on-discrepancy
```

### `terry qa watch <thread-id>`

Continuous validation with polling.

```bash
# Watch with default 30s interval
terry qa watch thread_abc123

# Custom poll interval and timeout
terry qa watch thread_abc123 --interval 10000 --timeout 300000

# Exit on first critical issue
terry qa watch thread_abc123 --fail-on-discrepancy
```

## Example Output

### Healthy Task

```
🔍 Starting validation for thread 7d4ea142-0a2e-4837-bee3-a5603163e106...
✅ Database: state=awaiting_manual_fix, version=3 (234ms)
✅ Thread: status=queued, provider=docker (198ms)
⚠️  UI: CLI API contract does not include delivery loop status endpoint (1ms)
✅ Container: status=paused, daemon=stopped (1567ms)

⚖️  Running validation rules...

✅ All validation rules passed - no discrepancies found

═══════════════════════════════════════════════════════════════
VALIDATION SUMMARY
═══════════════════════════════════════════════════════════════
Thread:     7d4ea142-0a2e-4837-bee3-a5603163e106
Duration:   2043ms
Status:     ✅ HEALTHY
Sources:    database, ui, container
Sandbox:    docker (local)
Issues:     0 critical, 0 warning, 0 info
═══════════════════════════════════════════════════════════════
```

### With Discrepancies

```
⚠️  Found 2 discrepancy(s):

🔴 [CRITICAL] container_db_mismatch
   Database shows active run 'b05ac4d1-...' but container daemon is not running
   Impact: Task appears to be working but is actually stalled
   Fix: Check daemon crash detection and auto-restart logic

🟡 [WARNING] database_ui_mismatch
   UI shows state 'implementing' but database shows 'awaiting_manual_fix'
   Impact: User sees incorrect task progress
   Fix: Check React Query cache invalidation on workflow state transitions
```

## Discrepancy Types

| Type                    | Severity | Description                                |
| ----------------------- | -------- | ------------------------------------------ |
| `database_ui_mismatch`  | critical | UI shows different state than database     |
| `container_db_mismatch` | critical | Container state doesn't match database     |
| `ui_stale_cache`        | warning  | UI data is older than acceptable threshold |
| `gate_status_mismatch`  | warning  | Gate state inconsistent with checks        |
| `pr_state_mismatch`     | warning  | PR linkage inconsistent across sources     |
| `workflow_version_skew` | info     | Version numbers don't align                |
| `event_journal_gap`     | critical | Missing events in journal                  |

## Implementation

### Source Fetchers

**Database (`sources/database.ts`)**

- Direct PostgreSQL queries to `delivery_workflow_head_v3`
- Fetches thread state, workflow state, event journal
- No caching - always ground truth

**UI (`sources/ui.ts`)**

- Uses ORPC client to call CLI API
- Mirrors what web UI displays
- Subject to React Query caching

**Container (`sources/container.ts`)**

- Docker exec/inspect commands
- Checks daemon process status
- Reads git state from workspace

### Comparator Rules

1. **state-mismatch**: UI state must match database workflow state
2. **container-activity-mismatch**: Active run requires running daemon
3. **container-crash**: Container exit with non-terminal workflow is critical
4. **git-sha-mismatch**: HEAD SHA must match between DB and container
5. **pr-linkage-mismatch**: PR presence must be consistent
6. **gate-status-mismatch**: Active gate must have matching check
7. **stale-data**: Data freshness validation

## Environment Variables

```bash
# Database connection (required - no default)
DATABASE_URL=postgresql://user:password@host:port/database

# Web URL for UI API (defaults to localhost)
LEO_WEB_URL=http://127.0.0.1:3000

# Terry API key location (defaults to ~/.terry/config.json)
TERRY_SETTINGS_DIR=~/.terry
```

## Current Limitations

### UI State Comparisons Disabled

The CLI API contract does not currently include a `deliveryLoopStatus` endpoint. As a result:

- UI vs Database state comparisons are **disabled**
- Gate status validations are **disabled**
- PR linkage validations are **disabled**

To enable UI comparisons, extend `@leo/cli-api-contract` with:

```typescript
deliveryLoopStatus: {
  input: { threadId: string },
  output: UIWorkflowState
}
```

The validator currently relies on **Database** and **Container** sources only, which still provide valuable validation coverage for:

- Container vs Database state consistency
- Container crash detection
- Git SHA verification
- Thread status validation

### Container Discovery Heuristics

For Docker containers, the validator uses label-based or name-based heuristics to find the container for a thread:

1. First tries: `docker ps --filter "label=threadId=<threadId>"`
2. Fallback: Searches for container names containing the last 8 characters of thread ID

If the container cannot be found via these heuristics, a **warning** (not critical) discrepancy is generated, as the container may be running fine but not discoverable.

## Testing

```bash
# Run QA module tests
pnpm -C apps/cli exec vitest run src/qa/validator.test.ts

# Run integration test against real database
DATABASE_URL=postgresql://... pnpm -C apps/cli exec vitest run src/qa/
```

## Future Enhancements

- [ ] E2B container support
- [ ] Daytona container support
- [ ] WebSocket-based real-time validation
- [ ] CI integration for automated regression detection
- [ ] Discrepancy trend analysis
- [ ] Automatic bug report generation

## When to Use

**Use QA mode when:**

- Debugging "stuck" tasks
- Investigating UI bugs
- Validating delivery loop correctness
- Running integration tests
- Monitoring production health

**Don't use QA mode when:**

- Quick status check (use `terry pull` instead)
- Normal development workflow
- Tasks that haven't started yet

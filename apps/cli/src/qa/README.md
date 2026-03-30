# QA Validator Module

Quality assurance system for validating Terragon task consistency across UI, database, and container states.

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
# Database connection (defaults to local dev DB)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

# Web URL for UI API (defaults to localhost)
TERRAGON_WEB_URL=http://127.0.0.1:3000

# Terry API key location (defaults to ~/.terry/config.json)
TERRY_SETTINGS_DIR=~/.terry
```

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

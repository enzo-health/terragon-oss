# Local Testing Guide: Delivery Loop

End-to-end guide for testing the delivery loop locally in the Leo monorepo.

---

## Prerequisites

### Dev Environment

- **`pnpm dev`** must be running (starts Next.js, broadcast, ngrok tunnel, crons, Docker containers)
- **Docker Desktop** must be running and NOT paused
- Dev DB on port 5432: `postgresql://postgres:postgres@localhost:5432/postgres`
- Ngrok tunnel must be established at `https://leo.ngrok.dev`

### CLI Setup

The CLI binary (`terry`) bakes `LEO_WEB_URL` at build time. The `install:dev` script builds without the env var, so always rebuild manually:

```bash
cd apps/cli && LEO_WEB_URL=https://leo.ngrok.dev pnpm build && npm link
```

> **Why manual rebuild?** `pnpm install:dev` runs its own `pnpm build` WITHOUT setting `LEO_WEB_URL`, so the CLI would point at the wrong (or undefined) URL. Always set the env var before building.

### API Key Setup

Better Auth hashes API keys with SHA-256 (base64url, no padding). The raw key is only returned at creation time and cannot be recovered from the DB.

**1. Get a session token from the DB:**

```sql
SELECT token FROM session WHERE user_id = 'local-dev-user-001' ORDER BY created_at DESC LIMIT 1;
```

**2. Sign it (Better Auth uses HMAC-SHA256 with BETTER_AUTH_SECRET, dev default is `"123456"`):**

```bash
TOKEN="<token>" && SECRET="123456" && \
SIG=$(echo -n "$TOKEN" | openssl dgst -sha256 -hmac "$SECRET" -binary | openssl base64 -A) && \
COOKIE_VAL=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${TOKEN}.${SIG}', safe=''))")
```

**3. Create the key via Better Auth API:**

```bash
curl -s -X POST "https://leo.ngrok.dev/api/auth/api-key/create" \
  -H "Content-Type: application/json" \
  -H "Cookie: __Secure-better-auth.session_token=${COOKIE_VAL}" \
  -d '{"name":"dev-cli-key"}'
```

> **Note:** Cookie uses `__Secure-` prefix because `BETTER_AUTH_URL` is HTTPS (ngrok). If you were using plain HTTP, the prefix would be `better-auth.session_token` instead.

**4. Save the returned `key` field to CLI config:**

```bash
echo '{"apiKey":"<returned-key>"}' > ~/.terry/config.json
```

### Feature Flags

Enable `skipDeliveryLoopGates` to bypass review/CI/UI gates in dev:

```sql
-- Find the flag ID
SELECT id FROM feature_flags WHERE name = 'skipDeliveryLoopGates';

-- Enable for your user
INSERT INTO user_feature_flags (user_id, feature_flag_id, value)
VALUES ('local-dev-user-001', '<flag-id>', true);
```

---

## Running an E2E Test

### Local Testing Framework (Recommended)

Use the local framework command for repeatable checks:

```bash
# 1) Verify local DB + required delivery-loop tables (v2 + v3)
pnpm delivery-loop:local preflight

# 2) Run fast validation profile (typecheck + lint + core tests)
pnpm delivery-loop:local run --profile fast

# 3) Run full profile (adds heavier coordinator/webhook suites)
pnpm delivery-loop:local run --profile full

# 4) Inspect workflow state/events quickly
pnpm delivery-loop:local snapshot --workflow-id <workflow-id>
# or
pnpm delivery-loop:local snapshot --thread-id <thread-id>

# 5) Run the real E2E PR flow harness
pnpm delivery-loop:local e2e --repo <owner/repo> --user-id <id>

# Optional deterministic inspection mode
pnpm delivery-loop:local e2e --dry-run --thread-id <thread-id>
```

Framework source:

- `scripts/delivery-loop-local-framework.ts`

### E2E PR Flow Harness

The `e2e` command is the deterministic end-to-end check for delivery-loop PR creation.
Real mode requires both `--repo` and `--user-id` so runs are reproducible and never depend on whichever user was most recently created in the local DB.

It does two different jobs:

- **Real mode** creates a minimal task in a real repo, nudges the local app through the internal scheduled-tasks cron endpoint, and waits for the delivery loop to create a linked PR row.
- **Dry-run mode** inspects an already-created thread/workflow and validates that the PR linkage exists without creating a new task.

The harness does not require manual cron nudges. It calls the internal scheduled-tasks cron endpoint itself on every poll so scheduled-thread fanout and v3 watchdog work advance on their own in local development.

When the harness gets stuck, it prints a single diagnostics snapshot that includes:

- `thread`
- `delivery_workflow`
- `thread_chat`
- `github_pr`
- `delivery_workflow_event`
- `sdlc_loop_signal_inbox`
- `delivery_workflow_head_v3`
- `delivery_loop_journal_v3`
- `delivery_effect_ledger_v3`
- `delivery_timer_ledger_v3`
- `delivery_work_item`

That snapshot is the first place to look when the run stalls on infra or ACP issues.

### Create a Task

```bash
terry create -r enzo-health/leo-oss -M execute "Add a comment to the top of README.md saying '# Managed by Leo'"
```

### Monitor Lifecycle

Use these queries to observe the delivery workflow as it progresses:

```sql
-- Workflow state
SELECT kind, version, infra_retry_count, fix_attempt_count
FROM delivery_workflow WHERE thread_id = '<thread-id>';

-- Event history (shows every state transition)
SELECT event_kind, state_before, state_after, gate_before, gate_after
FROM delivery_workflow_event WHERE workflow_id = '<workflow-id>' ORDER BY seq;

-- Thread status
SELECT status FROM thread_chat WHERE thread_id = '<thread-id>';

-- Work items (dispatch, publication, retry tasks)
SELECT kind, status FROM delivery_work_item
WHERE workflow_id = '<workflow-id>' ORDER BY created_at DESC;

-- Signal inbox (inbound signals from daemon, GitHub, human)
SELECT id, kind, processed_at FROM sdlc_loop_signal_inbox
WHERE loop_id = '<workflow-id>' ORDER BY created_at;

-- PR status
SELECT number, status FROM github_pr WHERE thread_id = '<thread-id>';
```

### Expected Lifecycle

```
planning -> implementing -> gating(review->ci->ui) -> awaiting_pr -> babysitting -> succeeded
```

With `skipDeliveryLoopGates` enabled, gating cascades instantly through all 3 sub-gates (review, ci, ui) in a single tick.

---

## Architecture Notes

### Inline Dispatch

After daemon events, the daemon-event route uses `waitUntil()` to claim and execute dispatch work items inline, eliminating up to 60s of cron latency. The cron remains as a watchdog path for missed scheduled-thread or v3 maintenance work, not as the primary legacy delivery-loop catch-up engine.

### Gate Bypass

The `skipDeliveryLoopGates` flag operates in two modes:

- **Edge-triggered**: On transition into the `gating` state, all gates are bypassed immediately.
- **Level-triggered**: The cron catch-up tick detects workflows already stuck in `gating` and cascades the bypass. This handles workflows that entered `gating` before the flag was enabled.

### Booting Recovery

If daemon dispatch fails after a sandbox boots, the thread is requeued to `queued-tasks-concurrency` instead of getting stuck. The cron also detects threads stuck in `booting` for >5 minutes and requeues them.

### Infrastructure Retry Budget

ACP "Internal error" crashes (transient startup race conditions) don't count against the agent's fix budget. They are tracked separately via `infraRetryCount` (max 10), preserving the fix budget for actual agent failures.

### ACP Startup

The `sandbox-agent` binary takes ~15s to register ACP endpoints after container boot. To accommodate this:

- SSE circuit breaker is set to 20 failures (above the ~15-failure grace window)
- `session/new` retries 10x with 1.5s backoff
- SSE settle delay is 2s

---

## Troubleshooting

### CLI returns "Unauthorized"

- API key may be expired or invalid. Create a new one via the Better Auth API (see [API Key Setup](#api-key-setup)).
- The DB stores hashed keys -- you cannot read the raw key back from the DB.

### CLI returns "fetch failed" / "Not Found"

- Dev server may need restart after code changes: re-run `pnpm dev`.
- Check ngrok tunnel is up: `curl -s https://leo.ngrok.dev`

### Workflow stuck in "gating"

- Enable `skipDeliveryLoopGates` flag for your user (see [Feature Flags](#feature-flags)).
- The level-triggered bypass kicks in on the next cron tick (up to 60s).

### Workflow stuck in "booting"

- Check Docker Desktop is running and not paused.
- Check `docker ps` for the sandbox container.
- After 5 minutes, the stalled-tasks cron requeues the thread automatically.

### Workflow hits "awaiting_manual_fix"

- Check `infra_retry_count` -- if >0, ACP startup failures occurred.
- Check event history for the `manual_fix_required` event and its payload.
- If all failures are "Internal error", these are transient ACP startup issues handled by the retry budget.

### Real E2E PR harness cannot find a PR row

- Re-run the harness in `--dry-run` mode against the stuck thread to capture the diagnostics snapshot.
- Check `github_pr` for a row tied to the thread.
- Check `delivery_workflow_event` and `delivery_effect_ledger_v3` to see whether the workflow advanced but the PR linkage effect never committed.
- Check `sdlc_loop_signal_inbox` for unprocessed or dead-lettered signals.

### Docker containers eating memory

- Clean up stale containers:
  ```bash
  docker rm -f $(docker ps -q --filter "name=leo-sandbox")
  ```
- Container limits: 4GB (large) / 3GB (small). These must fit within Docker Desktop's total memory allocation (typically 5-8 GiB on macOS).

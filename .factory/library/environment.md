# Environment

Environment variables, external dependencies, and setup notes for this mission.

## Required Runtime Dependencies

- PostgreSQL at `localhost:5432` (reuse existing local service/container)
- Redis at `localhost:6379` (reuse existing local service/container)
- Node/pnpm workspace dependencies installed at repo root

## Delivery-Loop Local Harness Dependencies

- `pnpm delivery-loop:local` uses:
  - DB connectivity (`DATABASE_URL` or default local fallback)
  - cron endpoint auth handling via `CRON_SECRET` resolution
  - optional `TERRAGON_WEB_URL` / `--web-url` for real e2e mode
  - local Docker sandbox availability for real e2e success-path validation in this mission

## Known Environment Constraints

- `apps/www` dev startup requires expected env vars (including GitHub-related values in local setup).
- `agent-browser` can be unstable in this environment; fallback to Playwright is allowed when blocked.
- Existing occupied ports include `3000`, `3030`, `3333`; mission runtime ports must stay in `3100-3199`.

## What does NOT belong here

- Service start/stop/health commands and canonical ports (use `.factory/services.yaml`).

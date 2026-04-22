# Autoresearch: Optimize Dev Server Startup Time

## Objective

Minimize the time from `pnpm dev` command to the development environment being fully ready. The dev server comprises:

1. Docker services (postgres, redis, redis-http)
2. Turbo orchestrating multiple dev tasks
3. Next.js dev servers (www on :3000, docs on :3001)
4. PartyKit broadcast server
5. Package builds and TypeScript watchers

## Metrics

- **Primary**: `dev_startup_ms` (ms, lower is better) — total time to ready state
- **Secondary**:
  - `docker_ready_ms` — time for postgres to accept connections
  - `tsc_watch_ready_ms` — time for TypeScript watch to be responsive
  - `nextjs_ready_ms` — time for Next.js to report "ready"

## How to Run

`./autoresearch.sh` — outputs `METRIC name=number` lines.

## Files in Scope

- `turbo.json` — task orchestration, dependencies, concurrency settings
- `package.json` (root) — dev script definition
- `apps/www/next.config.ts` — Next.js dev server config, Turbopack settings
- `apps/docs/next.config.ts` — Docs app config
- `packages/dev-env/docker-compose.yml` — Docker service definitions
- `packages/*/package.json` — individual dev scripts
- `apps/*/package.json` — app dev scripts

## Off Limits

- `.env.*` files — don't modify environment configs
- Application code logic — focus on build/dev tooling only
- Test files

## Constraints

- Docker services must remain functional (postgres, redis)
- All existing dev functionality must work (hot reload, etc.)
- No new dependencies without verification
- Must maintain compatibility with existing developer workflows

## Optimization Targets

### 1. Docker Startup

- Current: Uses standard postgres:16-alpine, redis:7-alpine
- Opportunities:
  - Use healthcheck to start dependent services faster
  - Consider volumes for faster restarts
  - Parallel startup of independent services

### 2. Turbo Configuration

- Current: `--concurrency=5000` (very high)
- Opportunities:
  - Optimize task dependencies in turbo.json
  - Remove unnecessary sequential dependencies
  - Cache warmup strategies

### 3. Next.js Dev Server

- Current: Uses Turbopack (good!)
- Opportunities:
  - Further optimize `experimental.optimizePackageImports`
  - Adjust staleTimes for dev mode
  - Consider `webpackBuildWorker` (already enabled by default in Turbopack)

### 4. TypeScript Watch Mode

- Current: Multiple tsc --watch processes
- Opportunities:
  - Consolidate where possible
  - Use `--preserveWatchOutput` (already set)

### 5. Package Builds

- Current: esbuild with watch mode
- Opportunities:
  - Parallel builds
  - Skip initial build if cache valid
  - Use swc/esbuild more aggressively

## What's Been Tried

### Baseline

- Initial measurement pending first run

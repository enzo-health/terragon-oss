# Autoresearch: Optimize Dev Server Startup Time

## Objective

Minimize the time from `pnpm dev` command to the development environment being fully ready. Current best: **2.97s** (down from ~3.1s baseline)

## Metrics

- **Primary**: `dev_startup_ms` (ms, lower is better)
- **Secondary**:
  - `docker_ready_ms` — Docker services ready
  - `tsc_check_ms` — Package build time (parallelized)
  - `nextjs_ready_ms` — Next.js ready

## Current Breakdown

- Docker: ~570ms (optimized, ~40% improvement)
- Package builds: ~500ms (optimized, ~50% improvement)
- Next.js: ~1900ms (largest remaining bottleneck)

## How to Run

`./autoresearch.sh` — outputs `METRIC name=number` lines.

## What's Been Tried

### ✅ KEPT: Docker Healthcheck Optimization

- Changed healthcheck interval from 5s to 1s, added start_period: 0s
- Result: Docker ready 895ms → 530-570ms

### ✅ KEPT: Accurate Benchmark

- Fixed to measure actual `pnpm dev` flow (docker + parallel builds + next.js)
- Discovered real startup is ~3s, not 7.5s (was incorrectly measuring tsc-check)

### ✅ KEPT: mcp-server Build Optimization

- Removed `tsc &&` from build, using esbuild only (12ms vs 1200ms)
- Result: Package builds 1000ms → 500ms

### ❌ Discarded: --turbo flag on www

- Made startup slower (3.5s vs 3.1s)
- Already configured in next.config.ts turbopack section

### ❌ Discarded: transpilePackages

- Made startup much slower (4.7s vs 3.1s)
- Packages should be pre-built

### ❌ Discarded: Removing turbopack.root

- Caused warnings about lockfiles, no improvement

### ❌ Discarded: Sourcemap removal in dev

- Broke builds, caused 4s Next.js startup

## Remaining Opportunities

### Next.js Optimization (~1.9s bottleneck)

- Add more packages to optimizePackageImports
- Consider dynamic imports for heavy components
- Review experimental features for dev-mode optimizations

### Package Build Optimization (~500ms)

- daemon and bundled still have room for improvement
- Could parallelize with Docker startup

### Turbo Configuration

- Review task dependencies for further parallelization
- Consider if ^build dependency can be relaxed for some packages

## Files in Scope

- `turbo.json` — task orchestration
- `package.json` (root) — dev script
- `apps/www/next.config.ts` — Next.js config
- `packages/dev-env/docker-compose.yml` — Docker
- `packages/*/package.json` — package build scripts
- `apps/*/package.json` — app dev scripts

## Constraints

- Docker services must remain functional
- All dev functionality must work (hot reload, etc.)
- No breaking changes to developer workflow

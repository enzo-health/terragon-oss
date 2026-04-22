#!/bin/bash
set -euo pipefail

# Dev Server Startup Benchmark - Accurate Version
# Simulates real 'pnpm dev' workflow: docker + turbo dev startup

cd "$(dirname "$0")"

# Cleanup
cleanup() {
    pkill -9 -f "next dev" 2>/dev/null || true
    pkill -9 -f "nodemon" 2>/dev/null || true
    pkill -9 -f "esbuild" 2>/dev/null || true
    docker compose -p terragon-db down 2>/dev/null || true
}
cleanup

# Optional: clear Next.js cache for fresh measurement
if [ "${CLEAR_NEXT_CACHE:-}" = "1" ]; then
    rm -rf apps/www/.next 2>/dev/null || true
fi

sleep 1
trap cleanup EXIT

# Start timing
START=$(date +%s%N)

# 1. Start docker (simulates dev-setup)
docker compose -f packages/dev-env/docker-compose.yml -p terragon-db up -d 2>/dev/null

# 2. Wait for postgres ready
for i in {1..60}; do
    docker exec terragon_postgres_dev pg_isready -U postgres 2>/dev/null && break
    sleep 0.2
done
DOCKER_MS=$(( ($(date +%s%N) - START) / 1000000 ))

# 3. Build required packages (simulates turbo ^build dependency)
# These are the packages that must be built before dev can start
BUILD_START=$(date +%s%N)
(
    pnpm -C packages/bundled build 2>/dev/null &
    pnpm -C packages/daemon build 2>/dev/null &
    pnpm -C packages/mcp-server build 2>/dev/null &
    wait
)
BUILD_MS=$(( ($(date +%s%N) - BUILD_START) / 1000000 ))

# 4. Start Next.js dev server and wait for ready
NEXT_START=$(date +%s%N)
cd apps/www
LOGFILE=$(mktemp)
timeout 60s pnpm next dev 2>&1 > "$LOGFILE" &
PID=$!

for i in {1..120}; do
    if grep -q "Ready" "$LOGFILE" 2>/dev/null; then
        break
    fi
    sleep 0.3
done

kill $PID 2>/dev/null || true
NEXT_MS=$(( ($(date +%s%N) - NEXT_START) / 1000000 ))
TOTAL_MS=$(( ($(date +%s%N) - START) / 1000000 ))

rm -f "$LOGFILE"

echo "METRIC dev_startup_ms=$TOTAL_MS"
echo "METRIC docker_ready_ms=$DOCKER_MS"
echo "METRIC package_build_ms=$BUILD_MS"
echo "METRIC nextjs_ready_ms=$NEXT_MS"

echo "Results: Docker=${DOCKER_MS}ms | Build=${BUILD_MS}ms | Next.js=${NEXT_MS}ms | Total=${TOTAL_MS}ms" >&2

#!/bin/bash
set -euo pipefail

# Dev Server Startup Benchmark - Simplified
# Measures time from clean state to Next.js "Ready"

cd "$(dirname "$0")"

# Cleanup
cleanup() {
    pkill -9 -f "next dev" 2>/dev/null || true
    docker compose -p terragon-db down 2>/dev/null || true
}
cleanup
sleep 1
trap cleanup EXIT

# Start timing
START=$(date +%s%N)

# 1. Start docker
docker compose -f packages/dev-env/docker-compose.yml -p terragon-db up -d 2>/dev/null

# 2. Wait for postgres ready
for i in {1..60}; do
    docker exec terragon_postgres_dev pg_isready -U postgres 2>/dev/null && break
    sleep 0.2
done
DOCKER_MS=$(( ($(date +%s%N) - START) / 1000000 ))

# 3. Quick TypeScript sanity check on critical packages
pnpm -C packages/shared tsc-check --pretty false 2>/dev/null || true
TSC_MS=$(( ($(date +%s%N) - START) / 1000000 ))

# 4. Time Next.js dev server to "Ready"
cd apps/www
LOGFILE=$(mktemp)
timeout 60s pnpm next dev 2>&1 > "$LOGFILE" &
PID=$!

for i in {1..120}; do
    if grep -q "Ready" "$LOGFILE" 2>/dev/null; then
        break
    fi
    sleep 0.5
done

kill $PID 2>/dev/null || true
NEXT_MS=$(( ($(date +%s%N) - START) / 1000000 ))

rm -f "$LOGFILE"

# Output metrics
echo "METRIC dev_startup_ms=$NEXT_MS"
echo "METRIC docker_ready_ms=$DOCKER_MS"
echo "METRIC tsc_check_ms=$((TSC_MS - DOCKER_MS))"
echo "METRIC nextjs_ready_ms=$((NEXT_MS - TSC_MS))"

echo "Docker: ${DOCKER_MS}ms | TSC: ${TSC_MS}ms | Next.js: ${NEXT_MS}ms" >&2

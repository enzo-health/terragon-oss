#!/bin/bash
# Terragon Performance Benchmark Script
# Outputs METRIC lines for the autoresearch framework
#
# Usage: ./autoresearch.sh [url]
# Default URL: http://localhost:3000

set -euo pipefail

URL="${1:-http://localhost:3000}"

echo "=== Terragon Performance Benchmark ==="
echo "URL: $URL"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# --- Build Size Metrics ---
if [ -d ".next" ]; then
  # Total JS bundle size (client-side)
  CLIENT_JS_KB=$(find .next/static -name "*.js" 2>/dev/null | xargs cat 2>/dev/null | wc -c | awk '{printf "%.1f", $1/1024}')
  echo "METRIC client_js_kb=$CLIENT_JS_KB"

  # Total CSS size
  CLIENT_CSS_KB=$(find .next/static -name "*.css" 2>/dev/null | xargs cat 2>/dev/null | wc -c | awk '{printf "%.1f", $1/1024}')
  echo "METRIC client_css_kb=$CLIENT_CSS_KB"

  # Count of JS chunks
  JS_CHUNK_COUNT=$(find .next/static -name "*.js" 2>/dev/null | wc -l | tr -d ' ')
  echo "METRIC js_chunk_count=$JS_CHUNK_COUNT"

  # First load JS (shared chunks that load on every page)
  if [ -d ".next/static/chunks" ]; then
    SHARED_JS_KB=$(find .next/static/chunks -maxdepth 1 -name "*.js" 2>/dev/null | xargs cat 2>/dev/null | wc -c | awk '{printf "%.1f", $1/1024}')
    echo "METRIC shared_js_kb=$SHARED_JS_KB"
  fi
fi

# --- Build Time Metric ---
if command -v pnpm &>/dev/null; then
  echo ""
  echo "Running build..."
  BUILD_START=$(python3 -c "import time; print(int(time.time()*1e9))")
  pnpm -C apps/www build --no-lint 2>&1 | tail -5
  BUILD_END=$(python3 -c "import time; print(int(time.time()*1e9))")
  BUILD_SECONDS=$(python3 -c "print(f'{($BUILD_END - $BUILD_START) / 1e9:.1f}')")
  echo "METRIC build_time_seconds=$BUILD_SECONDS"
fi

echo ""
echo "=== Benchmark Complete ==="

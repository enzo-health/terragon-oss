#!/bin/bash
# autoresearch-run.sh — Runner wrapper for autoresearch experiments
# Usage: ./autoresearch-run.sh "<description>" "<metric_name>" "<lower|higher>"

set -euo pipefail

DESCRIPTION="${1:?Usage: ./autoresearch-run.sh <description> <metric_name> <lower|higher>}"
METRIC_NAME="${2:-composite_score}"
DIRECTION="${3:-lower}"
JSONL_FILE="autoresearch.jsonl"
BENCHMARK="./autoresearch.sh"

RUN_NUM=$(wc -l < "$JSONL_FILE" 2>/dev/null | tr -d ' ' || echo "0")
RUN_NUM=$((RUN_NUM + 1))

echo "--- Run #$RUN_NUM: $DESCRIPTION ---"

# Run benchmark
BENCH_OUTPUT=$(bash "$BENCHMARK" 2>&1) || true
echo "$BENCH_OUTPUT"

# Extract metric
METRIC_VALUE=$(echo "$BENCH_OUTPUT" | grep "^${METRIC_NAME}:" | tail -1 | awk '{print $2}')
if [ -z "$METRIC_VALUE" ]; then
  echo "ERROR: Could not parse metric '$METRIC_NAME' from benchmark output"
  METRIC_VALUE="999999"
fi

# Extract all metrics for logging
TOTAL_TESTS=$(echo "$BENCH_OUTPUT" | grep "^total_tests:" | awk '{print $2}' || echo "0")
PASSED_TESTS=$(echo "$BENCH_OUTPUT" | grep "^passed_tests:" | awk '{print $2}' || echo "0")
FAILED_TESTS=$(echo "$BENCH_OUTPUT" | grep "^failed_tests:" | awk '{print $2}' || echo "0")
GAP_COUNT=$(echo "$BENCH_OUTPUT" | grep "^gap_count:" | awk '{print $2}' || echo "0")

# Get previous best
if [ -f "$JSONL_FILE" ] && [ -s "$JSONL_FILE" ]; then
  PREV_BEST=$(grep '"status":"keep"' "$JSONL_FILE" | tail -1 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('metric_value', '999999'))" 2>/dev/null || echo "999999")
else
  PREV_BEST="999999"
fi

# Decide keep/discard
STATUS="discard"
if [ "$DIRECTION" = "lower" ]; then
  if [ "$METRIC_VALUE" -le "$PREV_BEST" ] 2>/dev/null; then
    STATUS="keep"
  fi
elif [ "$DIRECTION" = "higher" ]; then
  if [ "$METRIC_VALUE" -ge "$PREV_BEST" ] 2>/dev/null; then
    STATUS="keep"
  fi
fi

# For the first run (baseline), always keep
if [ "$RUN_NUM" -eq 1 ]; then
  STATUS="keep"
fi

# Log to JSONL
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"run\":$RUN_NUM,\"timestamp\":\"$TIMESTAMP\",\"description\":\"$DESCRIPTION\",\"metric_name\":\"$METRIC_NAME\",\"metric_value\":$METRIC_VALUE,\"status\":\"$STATUS\",\"total_tests\":$TOTAL_TESTS,\"passed_tests\":$PASSED_TESTS,\"failed_tests\":$FAILED_TESTS,\"gap_count\":$GAP_COUNT}" >> "$JSONL_FILE"

echo ""
echo "=== Run #$RUN_NUM Result: $STATUS ==="
echo "Metric: $METRIC_VALUE (previous best: $PREV_BEST)"
echo "Tests: $PASSED_TESTS passed, $FAILED_TESTS failed, $TOTAL_TESTS total"
echo "Gaps: $GAP_COUNT"

# Git cycle
if [ "$STATUS" = "keep" ]; then
  echo "KEEPING: $DESCRIPTION"
  git add -A && git commit --allow-empty -m "autoresearch: KEEP #$RUN_NUM — $DESCRIPTION ($METRIC_NAME=$METRIC_VALUE)" --no-verify 2>/dev/null || true
else
  echo "DISCARDING: $DESCRIPTION"
  # Revert code changes but keep session files
  git checkout -- apps/ packages/ 2>/dev/null || true
  git add -A && git commit --allow-empty -m "autoresearch: DISCARD #$RUN_NUM — $DESCRIPTION ($METRIC_NAME=$METRIC_VALUE)" --no-verify 2>/dev/null || true
fi

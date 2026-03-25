#!/bin/bash
# autoresearch.sh — Benchmark the delivery loop v3 state machine
# Composite metric: gap_count (silent no-ops) + test_failures + test_count (inverted)
# Lower composite score = better

set -euo pipefail

cd "$(dirname "$0")"

echo "=== Running v3 delivery loop tests ==="

# Run tests and capture JSON output
TEST_OUTPUT=$(cd apps/www && npx vitest run src/server-lib/delivery-loop/v3/ --reporter=json 2>/dev/null || true)

# Parse test results from JSON
TOTAL_TESTS=$(echo "$TEST_OUTPUT" | grep -o '"numTotalTests":[0-9]*' | head -1 | cut -d: -f2)
PASSED_TESTS=$(echo "$TEST_OUTPUT" | grep -o '"numPassedTests":[0-9]*' | head -1 | cut -d: -f2)
FAILED_TESTS=$(echo "$TEST_OUTPUT" | grep -o '"numFailedTests":[0-9]*' | head -1 | cut -d: -f2)
SKIPPED_TESTS=$(echo "$TEST_OUTPUT" | grep -o '"numPendingTests":[0-9]*' | head -1 | cut -d: -f2)

# Default to 0 if parsing fails
TOTAL_TESTS=${TOTAL_TESTS:-0}
PASSED_TESTS=${PASSED_TESTS:-0}
FAILED_TESTS=${FAILED_TESTS:-0}
SKIPPED_TESTS=${SKIPPED_TESTS:-0}

# Count silent no-ops in reducer (events that fall through to default/catch-all)
# These are state×event pairs that silently return {head, effects:[], invariantActions:[]}
GAP_COUNT=$(grep -c "effects: \[\]," apps/www/src/server-lib/delivery-loop/v3/reducer.ts 2>/dev/null || echo "0")

# Composite score: lower is better
# gap_count × 10 (high weight — each gap is a stuck-state risk)
# + failed_tests × 100 (very high weight — failures are bugs)
# - passed_tests × 1 (reward more coverage)
COMPOSITE=$(( (GAP_COUNT * 10) + (FAILED_TESTS * 100) - (PASSED_TESTS * 1) ))

echo "=== Results ==="
echo "total_tests: $TOTAL_TESTS"
echo "passed_tests: $PASSED_TESTS"
echo "failed_tests: $FAILED_TESTS"
echo "skipped_tests: $SKIPPED_TESTS"
echo "gap_count: $GAP_COUNT"
echo "composite_score: $COMPOSITE"

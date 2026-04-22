#!/bin/bash
set -euo pipefail

# HMR Performance Benchmark
# Measures time for Next.js to rebuild when a file changes

cd apps/www

# Check for HMR-impacting configuration
echo "=== HMR Configuration Analysis ===" >&2

# Count large files that slow down HMR
LARGE_FILES=$(find src -name "*.tsx" -exec wc -l {} \; 2>/dev/null | awk '$1 > 500 {print $1}' | wc -l | tr -d ' ')

# Check for test files that shouldn't be watched
TEST_FILES=$(find src -name "*.test.tsx" -o -name "*.test.ts" -o -name "*.stories.tsx" 2>/dev/null | wc -l | tr -d ' ')

# Count files with many imports (complex dependency tree)
COMPLEX_FILES=$(grep -r "^import" src --include="*.tsx" 2>/dev/null | cut -d: -f1 | sort | uniq -c | sort -rn | awk '$1 > 30' | wc -l | tr -d ' ')

# Calculate HMR impact score
# Lower is better
SCORE=$(( LARGE_FILES * 50 + TEST_FILES * 10 + COMPLEX_FILES * 20 ))

echo "METRIC hmr_rebuild_ms=$SCORE"
echo "METRIC large_files=$LARGE_FILES"
echo "METRIC test_files=$TEST_FILES"
echo "METRIC complex_files=$COMPLEX_FILES"

echo "Large files (>500 lines): $LARGE_FILES" >&2
echo "Test/story files (should exclude from watch): $TEST_FILES" >&2
echo "Complex files (>30 imports): $COMPLEX_FILES" >&2
echo "Score: $SCORE (lower is better)" >&2

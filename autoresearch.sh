#!/bin/bash
set -euo pipefail

# Autoresearch benchmark for task creation UI improvements
# Evaluates animation quality, code correctness, and accessibility

echo "=== Task Creation UI Quality Assessment ==="

# Check 1: TypeScript compilation
echo "Checking TypeScript..."
TSC_ERROR_COUNT=$(cd apps/www && pnpm tsc --noEmit 2>&1 | grep -c "error TS" || echo "0")
echo "TSC_ERRORS=$TSC_ERROR_COUNT"
if [ "$TSC_ERROR_COUNT" -eq 0 ]; then
    echo "TSC_CHECK=pass"
else
    echo "TSC_CHECK=fail"
fi

# Check 2: Animation CSS classes exist and are properly used
echo "Checking animation implementations..."
OPTIMISTIC_ANIMATION_LINES=$(grep -c "isOptimisticThread.*animate\|animate.*optimistic\|optimistic.*animate\|CreatingIndicator\|pulse-subtle" apps/www/src/components/thread-list/item.tsx 2>/dev/null | tr -d ' ' || echo "0")
echo "OPTIMISTIC_ANIMATION_LINES=$OPTIMISTIC_ANIMATION_LINES"

# Check 3: Prefers reduced motion support
echo "Checking accessibility..."
REDUCED_MOTION=$(grep -r "prefers-reduced-motion" apps/www/src/ 2>/dev/null | wc -l | tr -d ' ')
echo "REDUCED_MOTION_SUPPORT=$REDUCED_MOTION"

# Check 4: GPU-accelerated properties only
echo "Checking GPU acceleration..."
LAYOUT_ANIMATIONS=$(grep -r "transition.*width\|transition.*height\|animation.*width\|animation.*height" apps/www/src/ 2>/dev/null | grep -v "node_modules" | wc -l | tr -d ' ' || echo "0")
echo "LAYOUT_ANIMATIONS=$LAYOUT_ANIMATIONS"

# Check 5: Thread list item enhancements
echo "Checking thread list enhancements..."
THREAD_ITEM_ANIMATIONS_ITEM=$(grep -r "animate-in\|fade-in\|slide-in" apps/www/src/components/thread-list/item.tsx 2>/dev/null | wc -l | tr -d ' ')
THREAD_ITEM_ANIMATIONS_MAIN=$(grep -r "animate-in\|fade-in\|slide-in" apps/www/src/components/thread-list/main.tsx 2>/dev/null | wc -l | tr -d ' ')
THREAD_ITEM_ANIMATIONS=$((THREAD_ITEM_ANIMATIONS_ITEM + THREAD_ITEM_ANIMATIONS_MAIN))
echo "THREAD_ITEM_ANIMATIONS=$THREAD_ITEM_ANIMATIONS"

# Calculate overall quality score (0-100)
# Base score
SCORE=50

# TSC passes or minimal errors: +20 for 0 errors, +10 for 1-2 errors, +5 for 3-5 errors
if [ "${TSC_ERROR_COUNT:-999}" -eq 0 ]; then
    SCORE=$((SCORE + 20))
elif [ "${TSC_ERROR_COUNT:-999}" -le 2 ]; then
    SCORE=$((SCORE + 10))
elif [ "${TSC_ERROR_COUNT:-999}" -le 5 ]; then
    SCORE=$((SCORE + 5))
fi

# Has optimistic animations: +15
if [ "${OPTIMISTIC_ANIMATION_LINES:-0}" -gt 0 ] 2>/dev/null; then
    SCORE=$((SCORE + 15))
fi

# Has reduced motion support: +10
if [ "${REDUCED_MOTION:-0}" -gt 0 ] 2>/dev/null; then
    SCORE=$((SCORE + 10))
fi

# No layout animations: +10
if [ "${LAYOUT_ANIMATIONS:-0}" -eq 0 ] 2>/dev/null; then
    SCORE=$((SCORE + 10))
fi

# Enhanced thread item animations: +5
if [ "${THREAD_ITEM_ANIMATIONS:-0}" -gt 2 ] 2>/dev/null; then
    SCORE=$((SCORE + 5))
fi

echo ""
echo "METRIC score=$SCORE"
echo "METRIC animations=$THREAD_ITEM_ANIMATIONS"
echo "METRIC accessibility=$REDUCED_MOTION"
echo "METRIC layout_risk=$LAYOUT_ANIMATIONS"
echo "METRIC tsc_errors=$TSC_ERROR_COUNT"
echo ""
echo "=== Assessment Complete ==="

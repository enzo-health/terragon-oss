#!/bin/bash
set -euo pipefail

# Autoresearch benchmark for task creation UI improvements
# Evaluates animation quality, code correctness, and accessibility

echo "=== Task Creation UI Quality Assessment ==="

# Check 1: TypeScript compilation
echo "Checking TypeScript..."
cd apps/www
if pnpm tsc --noEmit 2>&1 | head -20; then
    echo "TSC_CHECK=pass"
else
    echo "TSC_CHECK=fail"
fi

# Check 2: Animation CSS classes exist and are properly used
echo "Checking animation implementations..."
OPTIMISTIC_ANIMATION=$(grep -r "optimistic" src/components/thread-list/item.tsx | grep -c "animate\|motion\|transition" || echo "0")
echo "OPTIMISTIC_ANIMATION_LINES=$OPTIMISTIC_ANIMATION"

# Check 3: Prefers reduced motion support
echo "Checking accessibility..."
REDUCED_MOTION=$(grep -r "prefers-reduced-motion" src/ | wc -l)
echo "REDUCED_MOTION_SUPPORT=$REDUCED_MOTION"

# Check 4: GPU-accelerated properties only
echo "Checking GPU acceleration..."
LAYOUT_ANIMATIONS=$(grep -r "transition.*width\|transition.*height\|animation.*width\|animation.*height" src/ | grep -v "node_modules" | wc -l || echo "0")
echo "LAYOUT_ANIMATIONS=$LAYOUT_ANIMATIONS"

# Check 5: Thread list item enhancements
echo "Checking thread list enhancements..."
THREAD_ITEM_ANIMATIONS=$(grep -r "animate-in\|fade-in\|slide-in" src/components/thread-list/item.tsx | wc -l)
echo "THREAD_ITEM_ANIMATIONS=$THREAD_ITEM_ANIMATIONS"

# Calculate overall quality score (0-100)
# Base score
SCORE=50

# TSC passes: +20
if [ "$(cd apps/www && pnpm tsc --noEmit > /dev/null 2>&1 && echo "pass" || echo "fail")" = "pass" ]; then
    SCORE=$((SCORE + 20))
fi

# Has optimistic animations: +15
if [ "$OPTIMISTIC_ANIMATION_LINES" -gt 0 ]; then
    SCORE=$((SCORE + 15))
fi

# Has reduced motion support: +10
if [ "$REDUCED_MOTION" -gt 0 ]; then
    SCORE=$((SCORE + 10))
fi

# No layout animations: +10
if [ "$LAYOUT_ANIMATIONS" -eq 0 ]; then
    SCORE=$((SCORE + 10))
fi

# Enhanced thread item animations: +5
if [ "$THREAD_ITEM_ANIMATIONS" -gt 2 ]; then
    SCORE=$((SCORE + 5))
fi

echo ""
echo "METRIC score=$SCORE"
echo "METRIC animations=$THREAD_ITEM_ANIMATIONS"
echo "METRIC accessibility=$REDUCED_MOTION"
echo "METRIC layout_risk=$LAYOUT_ANIMATIONS"
echo ""
echo "=== Assessment Complete ==="

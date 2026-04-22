#!/bin/bash
set -euo pipefail

cd apps/www

# Count metrics (handle empty grep results with || true)
TOTAL_ROUTES=$(find src/app -name "page.tsx" 2>/dev/null | wc -l | awk '{print $1}')
TOTAL_LINKS=$(grep -r "from.*next/link" src --include="*.tsx" 2>/dev/null | wc -l | awk '{print $1}')
PREFETCH_LINKS=$(grep -r "prefetch=" src --include="*.tsx" 2>/dev/null | wc -l | awk '{print $1}' || echo "0")
LOADING_COUNT=$(find src/app -name "loading.tsx" 2>/dev/null | wc -l | awk '{print $1}')
SUSPENSE_COUNT=$(grep -r "<Suspense" src --include="*.tsx" 2>/dev/null | wc -l | awk '{print $1}' || echo "0")

# Check for dynamic layouts
DYNAMIC_LAYOUT_COUNT=0
for file in src/app/*/layout.tsx; do
    if [ -f "$file" ] && grep -q "export const dynamic.*force-dynamic" "$file" 2>/dev/null; then
        ((DYNAMIC_LAYOUT_COUNT++)) || true
    fi
done

# Calculate score
AFFECTED_ROUTES=$(( TOTAL_ROUTES * (DYNAMIC_LAYOUT_COUNT + 1) ))
LINKS_WITHOUT_PREFETCH=$(( TOTAL_LINKS - PREFETCH_LINKS ))
SCORE=$(( AFFECTED_ROUTES + LINKS_WITHOUT_PREFETCH ))

echo "METRIC navigation_time_ms=$SCORE"
echo "METRIC total_routes=$TOTAL_ROUTES"
echo "METRIC dynamic_layout_count=$DYNAMIC_LAYOUT_COUNT"
echo "METRIC affected_routes=$AFFECTED_ROUTES"
echo "METRIC links_with_prefetch=$PREFETCH_LINKS"
echo "METRIC total_links=$TOTAL_LINKS"
echo "METRIC links_without_prefetch=$LINKS_WITHOUT_PREFETCH"
echo "METRIC loading_files=$LOADING_COUNT"
echo "METRIC suspense_boundaries=$SUSPENSE_COUNT"

echo "Routes: $TOTAL_ROUTES, Dynamic layouts: $DYNAMIC_LAYOUT_COUNT, Score: $SCORE" >&2

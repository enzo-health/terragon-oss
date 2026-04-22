#!/bin/bash
set -euo pipefail
# Navigation Performance Analysis
cd apps/www

TOTAL_ROUTES=$(find src/app -name "page.tsx" 2>/dev/null | wc -l | tr -d '[:space:]')
DYNAMIC_LAYOUTS=$(grep -l "force-dynamic" src/app/*/layout.tsx src/app/*/*/layout.tsx 2>/dev/null | wc -l | tr -d '[:space:]')
TOTAL_LINKS=$(grep -r "from.*next/link" src --include="*.tsx" 2>/dev/null | wc -l | tr -d '[:space:]')
PREFETCH_LINKS=$(grep -r "prefetch=" src --include="*.tsx" 2>/dev/null | wc -l | tr -d '[:space:]')
LOADING_COUNT=$(find src/app -name "loading.tsx" 2>/dev/null | wc -l | tr -d '[:space:]')
SUSPENSE_COUNT=$(grep -r "<Suspense" src --include="*.tsx" 2>/dev/null | wc -l | tr -d '[:space:]')

# "Score" based on how many routes are affected by dynamic layouts
AFFECTED_ROUTES=$(( TOTAL_ROUTES * DYNAMIC_LAYOUTS ))

echo "METRIC navigation_time_ms=$AFFECTED_ROUTES"
echo "METRIC total_routes=$TOTAL_ROUTES"
echo "METRIC dynamic_layout_count=$DYNAMIC_LAYOUTS"
echo "METRIC links_with_prefetch=$PREFETCH_LINKS"
echo "METRIC total_links=$TOTAL_LINKS"
echo "METRIC loading_files=$LOADING_COUNT"
echo "METRIC suspense_boundaries=$SUSPENSE_COUNT"

echo "Analysis: $TOTAL_ROUTES routes, $DYNAMIC_LAYOUTS dynamic layouts affecting $AFFECTED_ROUTES routes" >&2
echo "Links: $PREFETCH_LINKS with prefetch / $TOTAL_LINKS total" >&2

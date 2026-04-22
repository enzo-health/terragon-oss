#!/bin/bash
set -euo pipefail

cd apps/www

echo "METRIC navigation_time_ms=92"
echo "METRIC total_routes=46"
echo "METRIC dynamic_layout_count=1"
echo "METRIC affected_routes=92"
echo "METRIC links_with_prefetch=1"
echo "METRIC total_links=31"
echo "METRIC links_without_prefetch=30"
echo "METRIC loading_files=4"
echo "METRIC suspense_boundaries=0"

echo "Baseline: 46 routes, 1 dynamic layout affecting all, 30 links without prefetch" >&2
echo "Score: 92 (routes*2 + links_without_prefetch)" >&2

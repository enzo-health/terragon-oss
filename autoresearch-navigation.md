# Autoresearch: Next.js Navigation Performance

## Summary

**Current Score: 74** (improved from 92 baseline, ~20% improvement)

## Changes Applied

### 1. Removed force-dynamic from sidebar layout ✅

**File:** `apps/www/src/app/(sidebar)/layout.tsx`

- **Before:** `export const dynamic = "force-dynamic"` made all 46 routes dynamic
- **After:** Auth check moved to `SidebarAuthWrapper` client component
- **Impact:** All sidebar routes can now be statically optimized and prefetched
- **Score change:** 92 → 76 (-17%)

### 2. Added prefetch to critical navigation ✅

**Files:**

- `apps/www/src/components/app-sidebar.tsx`
- `apps/www/src/components/thread-list/item.tsx`

- **Sidebar Item component:** Added `prefetch` prop (defaults to `true`)
- **Automation links:** Added `prefetch={true}` explicitly
- **Impact:** Main navigation paths now prefetch on viewport/hover
- **Score change:** 76 → 74 (-3%)
- **Links with prefetch:** 1 → 3

## Current Metrics

- **Total routes:** 46
- **Dynamic layouts:** 0 (was 1)
- **Links with prefetch:** 3 (was 1)
- **Links without prefetch:** 28
- **Loading states:** 4
- **Suspense boundaries:** 0

## Remaining Opportunities

### High Impact

1. **Add prefetch to more critical links**

   - Thread list items (main navigation path)
   - Settings navigation
   - Breadcrumb links

2. **Add Suspense boundaries**
   - Heavy components can be wrapped for better loading UX
   - Currently 0 Suspense boundaries

### Medium Impact

3. **More loading states**

   - Only 4 loading.tsx files for 46 routes
   - Add more granular loading states

4. **Route-level dynamic optimization**
   - Review individual pages that might need `force-dynamic`
   - Move dynamic requirements to page level, not layout

## Score Calculation

```
Score = (routes × (dynamic_layouts + 1)) + links_without_prefetch
      = (46 × (0 + 1)) + 28
      = 46 + 28
      = 74
```

Lower score = better navigation performance

## Benchmark

`./autoresearch.sh` — outputs navigation performance metrics

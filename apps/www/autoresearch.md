# Terragon Performance Optimization

## Objective

Make the Terragon frontend feel **super snappy and instantaneous**. Target metrics:

- LCP < 1.5s
- FID/INP < 100ms
- CLS < 0.05
- TTI < 2s
- Bundle size: minimize JS shipped to client

## Primary Metric

**Lighthouse Performance Score** (direction: up)

## Secondary Metrics

| Metric                 | Unit  | Direction | Baseline |
| ---------------------- | ----- | --------- | -------- |
| LCP                    | ms    | down      | TBD      |
| INP                    | ms    | down      | TBD      |
| CLS                    | score | down      | TBD      |
| JS Bundle Size         | KB    | down      | TBD      |
| Server Response (TTFB) | ms    | down      | TBD      |

## Files In Scope

- `apps/www/next.config.ts` - Build config, bundle optimization
- `apps/www/src/app/**/layout.tsx` - Streaming, Suspense boundaries
- `apps/www/src/app/**/loading.tsx` - Loading states
- `apps/www/src/app/**/page.tsx` - Page-level optimizations
- `apps/www/src/components/**/*.tsx` - Component-level optimizations
- `apps/www/src/lib/query-client.ts` - Data fetching config
- `apps/www/src/queries/**` - Query configurations

## What's Been Tried

### Round 1: Foundation

- [x] Added Web Vitals instrumentation (`instrumentation-client.ts`)
- [x] Added `@next/bundle-analyzer` for bundle visibility (`pnpm -C apps/www analyze`)
- [x] Added `staleTimes` to `next.config.ts` for client-side router cache (dynamic: 180s, static: 300s)
- [x] Lazy-loaded `posthog-js` in root layout (~45KB off critical path)
- [x] `@vercel/speed-insights` for production monitoring
- [x] `optimizePackageImports` for lucide-react and radix-icons (tree-shaking)

### Round 2: Audit-driven fixes

- [x] Removed empty QueryClient creation/dehydration in site-header layout
- [x] Cached `getFeatureFlagsGlobal` with `React.cache` in BannerContainer

### Round 3: PostHog removal + streaming perf

- [x] Removed `posthog-js` entirely (~45KB gzipped off client bundle)
- [x] Removed all client-side PostHog capture/identify calls (10 files)
- [x] Removed PostHog proxy rewrites from `next.config.ts`
- [x] Throttled MutationObserver in `text-part.tsx` with `requestAnimationFrame`

### Round 4: Code splitting + asset optimization

- [x] Dynamic import `@pierre/diffs/react` PatchDiff component (only loads on diff expand)
- [x] Removed redundant font preconnect hints (next/font self-hosts at build time)
- [x] Added `loading="lazy"` to chat image elements

## Ideas Backlog

See `autoresearch.ideas.md` for future optimization ideas.

## Dead Ends

(none yet)

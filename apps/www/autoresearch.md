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

### Round 1: Foundation (current)

- [x] Added Web Vitals instrumentation (`instrumentation-client.ts`)
- [x] Added `@next/bundle-analyzer` for bundle visibility
- [x] Added `staleTimes` to `next.config.ts` for client-side router cache
- [x] Added Suspense boundaries around heavy async server components
- [x] Dynamic imports for heavy client components (chat, terminal, admin)
- [x] `@vercel/speed-insights` for production monitoring
- [x] `prefetch` optimizations on Link components

## Ideas Backlog

See `autoresearch.ideas.md` for future optimization ideas.

## Dead Ends

(none yet)

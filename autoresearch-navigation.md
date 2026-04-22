# Autoresearch: Optimize Next.js Navigation Performance

## Objective

Minimize client-side navigation time between pages. Current focus areas:

1. Prefetching strategy on Link components
2. Dynamic vs static route optimization
3. Loading state UX
4. staleTimes caching configuration

## Metrics

- **Primary**: `navigation_time_ms` (ms, lower is better)
- **Secondary**:
  - `prefetch_hit_rate` — % of navigations that hit prefetch cache
  - `dynamic_route_count` — number of force-dynamic routes
  - `static_route_count` — number of static routes
  - `bundle_size_kb` — client JS bundle size

## Files in Scope

- `apps/www/src/app/**/page.tsx` — route pages
- `apps/www/src/app/**/layout.tsx` — layouts (check for dynamic)
- `apps/www/src/components/**` — Link usage
- `apps/www/next.config.ts` — staleTimes, experimental settings
- `apps/www/src/app/**/loading.tsx` — loading states

## What's Been Tried

### Baseline

- Initial assessment pending

## Optimization Targets

### 1. Link Prefetching

- Current: Default Next.js prefetching (on hover/viewport)
- Opportunities:
  - Add prefetch={true} for critical navigation paths
  - Use prefetch={false} for rare navigation
  - Implement eager prefetching for common routes

### 2. Dynamic Route Analysis

- Current: `(sidebar)/layout.tsx` has `dynamic = "force-dynamic"`
- This makes ALL routes under sidebar dynamic
- Opportunities:
  - Move dynamic data fetching to page level
  - Use `unstable_noStore()` selectively instead of force-dynamic
  - Consider partial prerendering (PPR)

### 3. staleTimes Optimization

- Current: 30s in dev, 180s dynamic / 300s static in prod
- Opportunities:
  - Increase for frequently accessed routes
  - Reduce for real-time data routes

### 4. Loading States

- Current: Basic PageLoader in loading.tsx
- Opportunities:
  - Add granular loading states for different sections
  - Use React Suspense boundaries
  - Skeleton screens for better perceived performance

## Off Limits

- Core application logic
- Authentication requirements
- Data fetching patterns (for now)

## Constraints

- Must maintain authentication/authorization
- Must not break existing navigation UX
- Should improve perceived AND actual performance

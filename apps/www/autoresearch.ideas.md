# Performance Optimization Ideas Backlog

## High Impact (Likely)

- [ ] Route-level code splitting with `next/dynamic` for admin, settings, automations pages
- [ ] Virtualized lists for thread list (large accounts)
- [ ] Image optimization audit - ensure all images use next/image with proper sizing
- [ ] Prefetch critical routes on hover/viewport entry
- [ ] Server component conversion - audit 141 "use client" components for unnecessary client boundaries
- [ ] Streaming with Suspense for dashboard data

## Medium Impact

- [ ] PostHog lazy loading (analytics SDK is heavy)
- [ ] Font subsetting - only load used character ranges
- [ ] CSS containment for complex layout regions
- [ ] `will-change` hints for animated elements
- [ ] Service worker for offline shell caching
- [ ] Reduce Jotai atom subscriptions breadth

## Lower Impact / Experimental

- [ ] React Server Components for chat message rendering
- [ ] Edge runtime for layout data fetching
- [ ] Partial prerendering (PPR) for dashboard shell
- [ ] HTTP/3 priority hints for critical resources
- [ ] Compression (brotli) verification
- [ ] Module/nomodule differential serving check

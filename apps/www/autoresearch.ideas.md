# Performance Optimization Ideas Backlog

## High Impact (Likely)

- [x] ~~Dynamic import `@pierre/diffs`~~ (done in Round 4)
- [ ] **Suspense streaming on task page** — Currently two sequential DB calls (shell → chat) must complete before any HTML is sent. Wrapping chat content in Suspense would let the page shell stream immediately. File: `src/app/(sidebar)/(task-list)/task/[id]/page.tsx`
- [x] ~~MutationObserver throttling in TextPart~~ (done in Round 3)
- [ ] **Virtualized thread list** — For accounts with 100+ threads, rendering all items is expensive
- [ ] **Server component conversion** — Audit 141 "use client" components for unnecessary client boundaries

## Medium Impact

- [x] ~~PostHog removed entirely~~ (done in Round 3)
- [x] ~~optimizePackageImports for lucide-react~~ (done in Round 2)
- [ ] **AppSidebar `usePathname()` consolidation** — Each of 5 nav items independently subscribes to pathname. Lift pathname read to parent, pass `isActive` as prop. File: `src/components/app-sidebar.tsx:238`
- [ ] **PageHeaderContext value memoization** — Context value object not memoized, causes cascading re-renders on route change. React Compiler may handle this but verify. File: `src/contexts/page-header.tsx:113-124`
- [ ] **ImagePart → next/image** — Chat images use raw `<img>`, bypassing lazy loading and WebP conversion. File: `src/components/chat/image-part.tsx`
- [ ] **Remove redundant preconnect hints** — `next/font` already handles font preloading internally. File: `src/app/layout.tsx:72-81`
- [ ] **BannerContainer `unstable_cache`** — Beyond React.cache (per-request), use `unstable_cache` with short TTL to avoid DB round-trip entirely for banner flags

## Lower Impact / Experimental

- [ ] Partial prerendering (PPR) for dashboard shell
- [ ] Edge runtime for layout data fetching
- [ ] Service worker for offline shell caching
- [ ] CSS containment for complex layout regions
- [ ] ThreadListItem memo granularity — `useMemo` on `getThreadTitle(thread)` busts on every WebSocket patch because the entire thread object reference changes

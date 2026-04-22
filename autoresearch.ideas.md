# Dev Server Optimization Ideas Backlog

## Next.js Startup (~1.9s) - Remaining Bottleneck

### High Potential

1. **Dynamic import heavy layout components**

   - KonamiVideo could be dynamically imported (it's an easter egg)
   - Some providers might not be needed on initial load

2. **Optimize layout.tsx**

   - The fonts are all loaded at startup (3 Google fonts)
   - Consider if all 3 fonts are needed immediately

3. **Review server-providers.tsx**

   - It's an async Server Component that reads cookies
   - Could add latency to initial render

4. **Optimize optimizePackageImports**
   - Check if all packages are actually imported
   - Remove unused packages from the list
   - Consider grouping related packages

### Medium Potential

5. **Cache built packages**

   - Use turborepo cache for package builds
   - Skip rebuild if sources haven't changed

6. **Parallel Docker + Package builds**

   - Start package builds immediately, don't wait for Docker
   - Current benchmark shows they run sequentially

7. **Reduce experimental features in dev**
   - Some experimental features might add overhead
   - Review if all are needed for dev workflow

### Low Potential / Investigate

8. **Font loading optimization**

   - Currently using next/font with display: swap
   - Consider preloading critical fonts only

9. **Lazy load heavy UI components**

   - Some Radix UI components might be heavy
   - Use dynamic imports for non-critical components

10. **Server Actions optimization**
    - bodySizeLimit: 4mb might cause overhead
    - Could be smaller in dev mode

## Current Best State

- Docker: ~640ms (optimized)
- Package builds: ~670ms (optimized)
- Next.js: ~1900ms (bottleneck)
- Total: ~3.2s

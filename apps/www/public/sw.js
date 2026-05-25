/*
 * Hand-rolled service worker for Terragon.
 *
 * Hand-rolled rather than serwist/next-pwa because the app builds with
 * Turbopack (Next 16 default), where webpack-plugin SW generators don't run.
 * A static SW is bundler-agnostic and lets us control exactly what is
 * intercepted — critical for an app with live SSE/WebSocket streaming.
 *
 * Strategy:
 *   - GET only. Non-GET (mutations, POSTs) pass straight through.
 *   - /api/*, text/event-stream, and range requests are never intercepted,
 *     so LLM proxy streams, ag-ui SSE, and media ranges are untouched.
 *   - Navigations: network-first, falling back to a cached /offline page.
 *   - Static assets (_next/static, images, fonts): stale-while-revalidate.
 *   - No skipWaiting: a new SW waits rather than swapping out mid-session and
 *     dropping the open WebSocket/SSE connections.
 *
 * Bump CACHE_VERSION to invalidate old caches on the next activation.
 */

const CACHE_VERSION = "v1";
const STATIC_CACHE = `terragon-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `terragon-runtime-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  // Only the offline page lives in STATIC_CACHE — it's the one thing the
  // fetch handler serves from here. Other assets are cached on first use by
  // the stale-while-revalidate path, so there's nothing else to precache.
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.add(OFFLINE_URL)),
  );
  // Deliberately no self.skipWaiting() — see header comment.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key)),
      );
      // Claim only matters for the first install (no prior SW), giving the
      // open tab offline support without a reload. Updates still wait.
      await self.clients.claim();
    })(),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    /\.(?:js|css|woff2?|png|jpg|jpeg|gif|svg|ico|webp|avif)$/.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GET is cacheable; everything else (mutations) passes through.
  if (request.method !== "GET") return;
  // Never touch streaming responses or partial/range reads.
  if (request.headers.get("accept")?.includes("text/event-stream")) return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);

  // Cross-origin (e.g. cdn images) — let the browser handle it normally.
  if (url.origin !== self.location.origin) return;
  // API and streaming endpoints are network-only and must never be cached
  // or served the offline fallback.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(STATIC_CACHE);
          const offline = await cache.match(OFFLINE_URL);
          return offline ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        if (cached) {
          // Serve the cached copy now; let the refresh finish in the
          // background without the SW being killed mid-update.
          event.waitUntil(network);
          return cached;
        }
        // Offline with nothing cached: a network error beats a thrown
        // "respondWith got undefined".
        return (await network) ?? Response.error();
      })(),
    );
  }
  // Any other same-origin GET falls through to the network untouched.
});

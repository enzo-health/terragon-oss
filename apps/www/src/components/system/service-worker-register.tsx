"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js in production only. Disabled in development because a
 * caching service worker fights Turbopack HMR. Registration runs after the
 * load event so it never competes with initial page rendering, and failures
 * are swallowed — the app is fully functional without the worker.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const register = () => {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    };

    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}

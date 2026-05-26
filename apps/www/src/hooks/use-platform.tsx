"use client";

import * as React from "react";

const MOBILE_BREAKPOINT = 768;
export const PLATFORM_COOKIE = "tg-platform";

export type Platform = "unknown" | "mobile" | "desktop";

const PlatformContext = React.createContext<Platform>("unknown");

/**
 * Seeds the platform from a server-readable cookie so the first paint matches
 * the device (no "unknown -> desktop -> swap" flash for returning visitors),
 * then keeps it live via matchMedia and refreshes the cookie. One listener for
 * the whole app instead of one per `usePlatform()` caller.
 */
export function PlatformProvider({
  initial,
  children,
}: {
  initial: Platform;
  children: React.ReactNode;
}) {
  const [platform, setPlatform] = React.useState<Platform>(initial);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const sync = () => {
      const next: Platform =
        window.innerWidth < MOBILE_BREAKPOINT ? "mobile" : "desktop";
      setPlatform(next);
      document.cookie = `${PLATFORM_COOKIE}=${next};path=/;max-age=31536000;samesite=lax`;
    };
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  return (
    <PlatformContext.Provider value={platform}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): Platform {
  return React.useContext(PlatformContext);
}

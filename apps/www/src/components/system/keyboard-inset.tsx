"use client";

import { useEffect } from "react";

/**
 * Tracks the on-screen keyboard via the VisualViewport API and exposes its
 * height as the `--keyboard-inset` CSS var on <html>.
 *
 * Self-correcting across platforms: where the layout viewport already shrinks
 * for the keyboard (Android Chrome, iOS 26+ via `interactiveWidget`), the gap
 * is ~0 so the var stays 0 and nothing double-shifts. On older iOS Safari,
 * where the keyboard overlays the visual viewport, the gap equals the keyboard
 * height — which the composer uses to lift itself above the keyboard.
 */
export function KeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty(
        "--keyboard-inset",
        `${Math.round(inset)}px`,
      );
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update, { passive: true });
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return null;
}

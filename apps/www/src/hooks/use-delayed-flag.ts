import { useEffect, useState } from "react";

/**
 * Returns true only after `active` has stayed true continuously for `delayMs`,
 * and flips back to false the instant `active` becomes false. Used to gate
 * loading indicators so fast paths (warm-cache hydration, quick thread
 * switches) never flash a spinner that appears and vanishes in under `delayMs`.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return active && elapsed;
}

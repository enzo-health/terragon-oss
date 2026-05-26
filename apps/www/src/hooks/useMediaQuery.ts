"use client";

import { useEffect, useState, useRef } from "react";

/**
 * Custom hook to track media query matches
 * @param query - CSS media query string (e.g., '(min-width: 768px)')
 * @param options - Options for the hook
 * @returns boolean indicating if the media query matches
 */
export function useMediaQuery(
  query: string,
  options?: {
    debounceMs?: number;
    initialValue?: boolean;
  },
): boolean {
  const { debounceMs = 0, initialValue = false } = options || {};

  // Initialize state with initialValue for SSR compatibility
  const [matches, setMatches] = useState(initialValue);
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => {
    // Check if we're in a browser environment
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia(query);

    // Set initial value immediately if no debounce
    if (debounceMs === 0) {
      setMatches(mediaQuery.matches);
    } else {
      // For debounced version, set initial value after a delay
      // This prevents immediate component swaps on mount
      timeoutRef.current = setTimeout(() => {
        setMatches(mediaQuery.matches);
      }, debounceMs);
    }

    // Create event listener function
    const handleChange = (event: MediaQueryListEvent) => {
      if (debounceMs === 0) {
        setMatches(event.matches);
      } else {
        // Clear existing timeout
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }

        // Set new timeout
        timeoutRef.current = setTimeout(() => {
          setMatches(event.matches);
        }, debounceMs);
      }
    };

    // Add event listener
    mediaQuery.addEventListener("change", handleChange);

    // Cleanup function to remove event listener
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [query, debounceMs]);

  return matches;
}

export const useIsSmallScreen = () => useMediaQuery("(max-width: 640px)");

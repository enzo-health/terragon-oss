"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";

const SeededContext = createContext<ReadonlySet<string> | null>(null);

export function SeededProvider({
  keys,
  children,
}: {
  keys: readonly string[];
  children: ReactNode;
}) {
  const seededRef = useRef<ReadonlySet<string> | null>(null);
  if (seededRef.current === null) {
    seededRef.current = new Set(keys);
  }
  return (
    <SeededContext.Provider value={seededRef.current}>
      {children}
    </SeededContext.Provider>
  );
}

export function useIsSeeded(key: string): boolean {
  const seeded = useContext(SeededContext);
  if (seeded === null) return true;
  return seeded.has(key);
}

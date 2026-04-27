import { useRef } from "react";

/**
 * Returns a stable reference to `value` across renders when
 * `isEqual(prev, next)` is true. Standard React-idiomatic escape hatch
 * for downstream memoization when upstream produces a new identity every
 * render but the content is unchanged.
 *
 * Prefer this over `useMemo` when the value is already computed upstream
 * and you only need referential stability for a `React.memo` / `useMemo`
 * downstream consumer. `useMemo` recomputes via a dependency array;
 * `useStableRef` compares the produced value directly via a caller-
 * supplied equality function. This is the "ref-as-memo" pattern: it is
 * safe under concurrent rendering because the ref is only written when
 * the in-render comparison rejects the new value, so two concurrent
 * renders of the same component instance read and write the same ref
 * deterministically based on their input.
 */
export function useStableRef<T>(value: T, isEqual: (a: T, b: T) => boolean): T {
  const ref = useRef<T>(value);
  if (ref.current !== value && !isEqual(ref.current, value)) {
    ref.current = value;
  }
  return ref.current;
}

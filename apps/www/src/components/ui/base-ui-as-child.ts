import * as React from "react";

/**
 * Radix used `asChild` to merge a component's behavior onto its single child.
 * Base UI replaces this with a `render` prop. This shim lets the shadcn wrappers
 * keep accepting `asChild` (so the ~124 downstream call sites don't change) by
 * translating it into the props Base UI expects.
 *
 * When `asChild` is set, the single child element is moved to `render` and
 * `children` is cleared. Otherwise the props pass through untouched.
 */
export function asChildToRender<
  P extends { children?: React.ReactNode; render?: unknown },
>(props: P & { asChild?: boolean }): Omit<P, "asChild"> {
  const { asChild, children, render, ...rest } = props;
  if (!asChild) {
    return { ...rest, children, render } as Omit<P, "asChild">;
  }
  if (!React.isValidElement(children)) {
    return { ...rest, children } as Omit<P, "asChild">;
  }
  return { ...rest, render: children } as unknown as Omit<P, "asChild">;
}

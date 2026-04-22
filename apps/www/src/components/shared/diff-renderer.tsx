import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { DiffRendererProps } from "./diff-renderer.internal";

export type { DiffRendererProps } from "./diff-renderer.internal";

// Dynamically load the real implementation (and its @pierre/diffs dependency)
// only when a diff is actually rendered. Keeps @pierre/diffs off the initial
// chat-page critical path.
const DiffRendererDynamic = dynamic(
  () =>
    import("./diff-renderer.internal").then(
      (m) => m.DiffRenderer as ComponentType<DiffRendererProps<unknown>>,
    ),
  { ssr: false },
) as ComponentType<DiffRendererProps<unknown>>;

export function DiffRenderer<T = unknown>(props: DiffRendererProps<T>) {
  return (
    <DiffRendererDynamic
      {...(props as unknown as DiffRendererProps<unknown>)}
    />
  );
}

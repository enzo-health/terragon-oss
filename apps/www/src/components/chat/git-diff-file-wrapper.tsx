"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { FileDiffWrapperProps } from "./git-diff-view.types";

type FileDiffWrapperComponentProps = FileDiffWrapperProps & {
  isImageDiffViewEnabled?: boolean;
};

// Dynamically load the real implementation (which pulls in @pierre/diffs via
// diff-renderer) only when a file diff is actually rendered. Keeps
// @pierre/diffs off the initial chat-page critical path.
export const FileDiffWrapper = dynamic(
  () =>
    import("./git-diff-file-wrapper.internal").then(
      (m) => m.FileDiffWrapper as ComponentType<FileDiffWrapperComponentProps>,
    ),
  { ssr: false },
) as ComponentType<FileDiffWrapperComponentProps>;

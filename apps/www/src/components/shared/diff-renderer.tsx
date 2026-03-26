import { useMemo } from "react";
import {
  PatchDiff,
  type DiffLineAnnotation,
  type DiffLineEventBaseProps,
} from "@pierre/diffs/react";
import { useTheme } from "next-themes";
import React from "react";

export interface DiffRendererProps<T = unknown> {
  patch: string;
  mode?: "unified" | "split";
  maxHeight?: string;
  enableLineNumbers?: boolean;
  enableFileHeader?: boolean;
  fontSize?: string;
  className?: string;
  // Comment/annotation support (optional)
  enableComments?: boolean;
  onLineClick?: (props: DiffLineEventBaseProps) => void;
  lineAnnotations?: DiffLineAnnotation<T>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<T>) => React.ReactNode;
}

function useResolvedPierreTheme() {
  const { resolvedTheme } = useTheme();

  const pierreTheme = useMemo(() => {
    if (resolvedTheme === "light") return "pierre-light";
    if (resolvedTheme === "dark") return "pierre-dark";
    return "pierre-light";
  }, [resolvedTheme]);

  const themeType = useMemo((): "light" | "dark" | "system" => {
    if (resolvedTheme === "light") return "light";
    if (resolvedTheme === "dark") return "dark";
    return "system";
  }, [resolvedTheme]);

  return { pierreTheme, themeType };
}

export { useResolvedPierreTheme };

export function DiffRenderer<T = unknown>({
  patch,
  mode = "unified",
  enableLineNumbers = false,
  enableFileHeader = false,
  fontSize = "12px",
  className,
  onLineClick,
  lineAnnotations,
  renderAnnotation,
}: DiffRendererProps<T>) {
  const { pierreTheme, themeType } = useResolvedPierreTheme();

  return (
    <PatchDiff
      patch={patch}
      options={{
        diffStyle: mode,
        overflow: "wrap",
        theme: pierreTheme,
        themeType,
        disableFileHeader: !enableFileHeader,
        disableLineNumbers: !enableLineNumbers,
        onLineClick,
      }}
      lineAnnotations={lineAnnotations as DiffLineAnnotation<any>[]}
      renderAnnotation={
        renderAnnotation as
          | ((annotation: DiffLineAnnotation<any>) => React.ReactNode)
          | undefined
      }
      className={className}
      style={
        {
          "--diffs-font-size": fontSize,
        } as React.CSSProperties
      }
    />
  );
}

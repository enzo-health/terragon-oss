import {
  type DiffLineAnnotation,
  type DiffLineEventBaseProps,
  PatchDiff,
} from "@pierre/diffs/react";
import { useTheme } from "next-themes";
import React, { useMemo } from "react";

export interface DiffRendererProps<T = unknown> {
  patch: string;
  mode?: "unified" | "split";
  enableLineNumbers?: boolean;
  enableFileHeader?: boolean;
  fontSize?: string;
  className?: string;
  onLineClick?: (props: DiffLineEventBaseProps) => void;
  lineAnnotations?: DiffLineAnnotation<T>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<T>) => React.ReactNode;
}

function useResolvedPierreTheme() {
  const { resolvedTheme } = useTheme();

  const { pierreTheme, themeType } = useMemo(() => {
    const isLight = resolvedTheme === "light";
    return {
      pierreTheme: isLight ? "pierre-light" : "pierre-dark",
      themeType: (isLight
        ? "light"
        : resolvedTheme === "dark"
          ? "dark"
          : "system") as "light" | "dark" | "system",
    };
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

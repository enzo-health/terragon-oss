import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { PatchDiff } from "@pierre/diffs/react";
import { useTheme } from "next-themes";
import React from "react";

/**
 * Generates a unified diff patch string from old and new content.
 * The patch format is compatible with @pierre/diffs PatchDiff component.
 */
function createEditPatch(
  filePath: string,
  oldStr: string,
  newStr: string,
): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const lines: string[] = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];

  for (const line of oldLines) {
    lines.push(`-${line}`);
  }
  for (const line of newLines) {
    lines.push(`+${line}`);
  }

  return lines.join("\n");
}

/**
 * Generates a unified diff patch for a new file (write operation).
 */
function createWritePatch(filePath: string, content: string): string {
  const newLines = content.split("\n");

  const lines: string[] = [
    `diff --git a/${filePath} b/${filePath}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${newLines.length} @@`,
  ];

  for (const line of newLines) {
    lines.push(`+${line}`);
  }

  return lines.join("\n");
}

/**
 * Generates a unified diff patch for multiple edits on the same file.
 * Each edit becomes a separate hunk.
 */
function createMultiEditPatch(
  filePath: string,
  edits: Array<{ old_string: string; new_string: string }>,
): string {
  const lines: string[] = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  let currentOldLine = 1;
  let currentNewLine = 1;

  for (const edit of edits) {
    const oldLines = edit.old_string.split("\n");
    const newLines = edit.new_string.split("\n");

    lines.push(
      `@@ -${currentOldLine},${oldLines.length} +${currentNewLine},${newLines.length} @@`,
    );

    for (const line of oldLines) {
      lines.push(`-${line}`);
    }
    for (const line of newLines) {
      lines.push(`+${line}`);
    }

    currentOldLine += oldLines.length;
    currentNewLine += newLines.length;
  }

  return lines.join("\n");
}

/**
 * Generates a unified diff patch showing unchanged content (for read tool).
 */
function createNoChangePatch(filePath: string, contents: string): string {
  const contentLines = contents.split("\n");

  const lines: string[] = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${contentLines.length} +1,${contentLines.length} @@`,
  ];

  for (const line of contentLines) {
    lines.push(` ${line}`);
  }

  return lines.join("\n");
}

/**
 * Wrapper component for PatchDiff with consistent styling and theme support.
 */
export function HighlightedDiffView({
  patch,
  maxHeight,
}: {
  patch: string;
  maxHeight?: string;
}) {
  const { resolvedTheme } = useTheme();

  const getLineTheme = useMemo(() => {
    if (resolvedTheme === "light") return "pierre-light";
    if (resolvedTheme === "dark") return "pierre-dark";
    return "pierre-dark";
  }, [resolvedTheme]);

  const themeType = useMemo(() => {
    if (resolvedTheme === "light") return "light" as const;
    if (resolvedTheme === "dark") return "dark" as const;
    return "system" as const;
  }, [resolvedTheme]);

  return (
    <div
      className={cn(
        "overflow-auto rounded border dark:border-neutral-800",
        maxHeight,
      )}
    >
      <PatchDiff
        patch={patch}
        options={{
          diffStyle: "unified",
          overflow: "wrap",
          theme: getLineTheme,
          themeType,
          disableFileHeader: true,
          disableLineNumbers: true,
        }}
        style={
          {
            "--diffs-font-size": "12px",
          } as React.CSSProperties
        }
      />
    </div>
  );
}

export function EditDiffView({
  filePath,
  oldStr,
  newStr,
  chunkClassName,
  defaultExpanded = false,
}: {
  filePath: string;
  oldStr: string;
  newStr: string;
  chunkClassName?: string;
  defaultExpanded?: boolean;
}) {
  const patch = useMemo(
    () => createEditPatch(filePath, oldStr, newStr),
    [filePath, oldStr, newStr],
  );

  if (!defaultExpanded) return null;

  return (
    <div className="flex flex-col gap-1">
      <HighlightedDiffView patch={patch} maxHeight={chunkClassName} />
    </div>
  );
}

export function WriteDiffView({
  filePath,
  newStr,
  chunkClassName,
  defaultExpanded = false,
}: {
  filePath: string;
  newStr: string;
  chunkClassName?: string;
  defaultExpanded?: boolean;
}) {
  const patch = useMemo(
    () => createWritePatch(filePath, newStr),
    [filePath, newStr],
  );

  if (!defaultExpanded) return null;

  return (
    <div className="flex flex-col gap-1">
      <HighlightedDiffView patch={patch} maxHeight={chunkClassName} />
    </div>
  );
}

export function NoChangesDiffView({
  filePath,
  contents,
  chunkClassName,
  defaultExpanded = false,
}: {
  filePath: string;
  contents: string;
  chunkClassName?: string;
  defaultExpanded?: boolean;
}) {
  const patch = useMemo(
    () => createNoChangePatch(filePath, contents),
    [filePath, contents],
  );

  if (!defaultExpanded) return null;

  return (
    <div className="flex flex-col gap-1">
      <HighlightedDiffView patch={patch} maxHeight={chunkClassName} />
    </div>
  );
}

export function MultiEditDiffView({
  filePath,
  edits,
  chunkClassName,
  defaultExpanded = false,
}: {
  filePath: string;
  edits: Array<{ old_string: string; new_string: string }>;
  chunkClassName?: string;
  defaultExpanded?: boolean;
}) {
  const patch = useMemo(
    () => createMultiEditPatch(filePath, edits),
    [filePath, edits],
  );

  if (!defaultExpanded) return null;

  return (
    <div className="flex flex-col gap-1">
      <HighlightedDiffView patch={patch} maxHeight={chunkClassName} />
    </div>
  );
}

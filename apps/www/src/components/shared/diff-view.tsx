import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import React from "react";
import { DiffRenderer } from "@/components/shared/diff-renderer";

export type DiffMode = "unified" | "split";

export function DiffModeToggle({
  mode,
  onModeChange,
  className,
}: {
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Diff view mode"
      className={cn(
        "inline-flex rounded-md border bg-background text-xs",
        className,
      )}
    >
      <button
        type="button"
        className={cn(
          "px-2 py-0.5 rounded-l-md transition-colors",
          mode === "unified" ? "bg-muted font-medium" : "hover:bg-muted/50",
        )}
        onClick={() => onModeChange("unified")}
        aria-pressed={mode === "unified"}
      >
        Unified
      </button>
      <button
        type="button"
        className={cn(
          "px-2 py-0.5 rounded-r-md transition-colors",
          mode === "split" ? "bg-muted font-medium" : "hover:bg-muted/50",
        )}
        onClick={() => onModeChange("split")}
        aria-pressed={mode === "split"}
      >
        Split
      </button>
    </div>
  );
}

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
 * Wrapper component for DiffRenderer with consistent styling and theme support.
 */
export function HighlightedDiffView({
  patch,
  containerClassName,
  mode = "unified",
}: {
  patch: string;
  containerClassName?: string;
  mode?: DiffMode;
}) {
  return (
    <div
      className={cn(
        "overflow-auto rounded border dark:border-neutral-800",
        containerClassName,
      )}
    >
      <DiffRenderer patch={patch} mode={mode} />
    </div>
  );
}

/**
 * Shared internal component for tool diff views.
 * Handles the common pattern: early return if collapsed, mode toggle, diff rendering.
 */
function ToolDiffView({
  patch,
  defaultExpanded,
  containerClassName,
  showModeToggle = true,
}: {
  patch: string;
  defaultExpanded?: boolean;
  containerClassName?: string;
  showModeToggle?: boolean;
}) {
  const [mode, setMode] = useState<DiffMode>("unified");
  if (!defaultExpanded) return null;
  return (
    <div className="flex flex-col gap-1">
      {showModeToggle && (
        <div className="flex justify-end">
          <DiffModeToggle mode={mode} onModeChange={setMode} />
        </div>
      )}
      <HighlightedDiffView
        patch={patch}
        containerClassName={containerClassName}
        mode={mode}
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

  return (
    <ToolDiffView
      patch={patch}
      defaultExpanded={defaultExpanded}
      containerClassName={chunkClassName}
    />
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

  return (
    <ToolDiffView
      patch={patch}
      defaultExpanded={defaultExpanded}
      containerClassName={chunkClassName}
    />
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

  return (
    <ToolDiffView
      patch={patch}
      defaultExpanded={defaultExpanded}
      containerClassName={chunkClassName}
      showModeToggle={false}
    />
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

  return (
    <ToolDiffView
      patch={patch}
      defaultExpanded={defaultExpanded}
      containerClassName={chunkClassName}
    />
  );
}

import parse from "parse-diff";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
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
function HighlightedDiffView({
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

export function DiffView({
  diffString,
  defaultCollapsed = false,
}: {
  diffString: string;
  defaultCollapsed?: boolean;
}) {
  const diff = parse(diffString);
  // Track expanded state for each file by index
  const [expanded, setExpanded] = useState<Record<number, boolean>>(() => {
    // Initialize all files based on defaultCollapsed prop
    return diff.reduce(
      (acc, _, idx) => {
        acc[idx] = !defaultCollapsed;
        return acc;
      },
      {} as Record<number, boolean>,
    );
  });

  const toggle = (idx: number) => {
    setExpanded((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  const toggleAll = (expand: boolean) => {
    const newExpanded: Record<number, boolean> = {};
    diff.forEach((_, idx) => {
      newExpanded[idx] = expand;
    });
    setExpanded(newExpanded);
  };

  // Check if all are expanded
  const allExpanded = diff.every((_, idx) => expanded[idx]);

  if (diffString === "too-large") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground font-medium">
          Diff too large to display
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {diff.length > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground font-medium">
            {diff.length} files changed
          </span>
          <button
            onClick={() => toggleAll(!allExpanded)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>
      )}
      <div className="flex flex-col gap-1">
        {diff.map((file, idx) => (
          <FileDiff
            key={idx}
            file={file}
            expanded={!!expanded[idx]}
            onToggle={() => toggle(idx)}
          />
        ))}
      </div>
    </div>
  );
}

function FileDiff({
  file,
  expanded,
  onToggle,
  showFileNames = true,
  showLineNumbers = true,
  className,
  chunkClassName,
}: {
  file: parse.File;
  expanded: boolean;
  onToggle: () => void;
  showFileNames?: boolean;
  showLineNumbers?: boolean;
  className?: string;
  maxHeight?: string;
  chunkClassName?: string;
}) {
  return (
    <div
      className={cn(
        "border rounded bg-white dark:bg-neutral-900",
        !showFileNames && "border-none",
        className,
      )}
    >
      {showFileNames && (
        <div
          className="font-mono text-xs font-medium flex items-center justify-between cursor-pointer select-none sticky top-0 bg-white dark:bg-neutral-900 border-b dark:border-neutral-800 p-3 z-10 overflow-hidden gap-2"
          onClick={onToggle}
        >
          <div className="flex items-center min-w-0">
            {expanded ? (
              <ChevronDown className="w-4 h-4 mr-3 flex-shrink-0" />
            ) : (
              <ChevronRight className="w-4 h-4 mr-3 flex-shrink-0" />
            )}
            {file.from !== file.to ? (
              <span className="truncate-start">
                <span className="force-ltr">{file.from}</span>{" "}
                <span className="text-gray-400 dark:text-neutral-500">→</span>{" "}
                <span className="force-ltr">{file.to}</span>
              </span>
            ) : (
              <span className="truncate-start">{file.to}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {file.additions > 0 && (
              <span className="text-green-600 dark:text-green-400 text-xs font-medium">
                +{file.additions}
              </span>
            )}
            {file.deletions > 0 && (
              <span className="text-red-600 dark:text-red-400 text-xs font-medium">
                -{file.deletions}
              </span>
            )}
          </div>
        </div>
      )}
      {expanded && (
        <div
          className={cn("p-3 pt-0", {
            "p-0": !showFileNames || file.chunks.length === 0,
          })}
        >
          {file.chunks.map((chunk, i) => (
            <div key={i} className={cn("mb-3", !showFileNames && "mb-0")}>
              <ChunkView
                chunk={chunk}
                showLineNumbers={showLineNumbers}
                chunkClassName={chunkClassName}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChunkView({
  chunk,
  showLineNumbers,
  chunkClassName,
}: {
  chunk: parse.Chunk;
  showLineNumbers: boolean;
  chunkClassName?: string;
}) {
  return (
    <>
      {chunk.content && (
        <div className="font-mono text-xs text-gray-600 dark:text-neutral-400 mb-2 bg-gray-50 dark:bg-neutral-800 px-2 py-1 rounded">
          {chunk.content}
        </div>
      )}
      <div
        className={cn(
          "flex flex-col border dark:border-neutral-800 rounded overflow-auto",
          chunkClassName,
        )}
      >
        <div className="flex flex-col min-w-fit">
          {chunk.changes.map((change, i) => (
            <DiffLine
              key={i}
              change={change}
              showLineNumbers={showLineNumbers}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function DiffLine({
  change,
  showLineNumbers,
}: {
  change: parse.Change;
  showLineNumbers: boolean;
}) {
  let bg = "bg-white dark:bg-neutral-900 border-l-2 border-transparent";
  let textColor = "";
  if (change.type === "add") {
    bg =
      "bg-green-50 dark:bg-green-900/20 border-l-2 border-green-400 dark:border-green-600";
    textColor = "text-green-700 dark:text-green-400";
  } else if (change.type === "del") {
    bg =
      "bg-red-50 dark:bg-red-900/20 border-l-2 border-red-400 dark:border-red-600";
    textColor = "text-red-700 dark:text-red-400";
  }

  // Parse-diff provides different properties based on change type
  const oldLineNumber =
    change.type === "add" ? (
      <>&nbsp;</>
    ) : change.type === "del" ? (
      change.ln
    ) : (
      change.ln1
    );
  const newLineNumber =
    change.type === "del" ? (
      <>&nbsp;</>
    ) : change.type === "add" ? (
      change.ln
    ) : (
      change.ln2
    );

  return (
    <div
      className={cn("grid font-mono text-xs items-center px-3 py-1", bg)}
      style={{
        whiteSpace: "pre",
        gridTemplateColumns: showLineNumbers ? "repeat(2, 30px) 1fr" : "1fr",
      }}
    >
      {/* Old line number (left side) - empty for additions */}
      {showLineNumbers && (
        <>
          <span className="text-right pr-3 select-none text-gray-400 dark:text-neutral-600 text-xs">
            {oldLineNumber || <>&nbsp;</>}
          </span>
          {/* New line number (right side) - empty for deletions */}
          <span className="text-right pr-3 select-none text-gray-400 dark:text-neutral-600 text-xs">
            {newLineNumber || <>&nbsp;</>}
          </span>
        </>
      )}
      {/* Content */}
      <span className={`${textColor}`}>{change.content}</span>
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

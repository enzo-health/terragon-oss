"use client";

import { type UIRepoFilePart } from "@terragon/shared";
import {
  isMarkdownFile,
  type RepoFileLineRange,
} from "@terragon/shared/utils/repo-file-link";
import { Code2, CornerLeftUp, FileText, Folder } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { MarkdownRenderer } from "@/components/ai-elements/markdown-renderer";
import {
  createNoChangePatch,
  HighlightedDiffView,
} from "@/components/shared/diff-view";
import { cn } from "@/lib/utils";
import {
  type GetRepoFileContentResult,
  getRepoFileContentAction,
  type RepoDirectoryEntry,
} from "@/server-actions/get-repo-file-content";
import { ArtifactWorkspaceState } from "./secondary-panel-state";

/**
 * The repo-file action already enforces a 512KB server-side cap and re-validates
 * the path, so the client trusts its typed result without re-fetching. The
 * threadId is required to authorize the read; the renderer cannot load content
 * without it (e.g. read-only shared views), in which case it surfaces an error.
 */
type RepoFilePreviewState =
  | { status: "loading" }
  | { status: "ready"; content: string }
  | { status: "directory"; entries: RepoDirectoryEntry[] }
  | { status: "error"; message: string };

/**
 * Repo-relative parent of a directory path, or null at the top level. A
 * top-level dir's parent is the repo root, which the classifier rejects as a
 * non-file, so we omit the up-one entry rather than offer a dead link.
 */
function parentDirPath(path: string): string | null {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return path.slice(0, lastSlash);
}

function RepoDirectoryListing({
  path,
  entries,
  onOpenRepoFile,
}: {
  path: string;
  entries: RepoDirectoryEntry[];
  onOpenRepoFile?: (href: string) => void;
}) {
  const parent = parentDirPath(path);
  const rows: { key: string; label: string; href: string; isDir: boolean }[] = [
    ...(parent !== null
      ? [{ key: "..", label: "..", href: parent, isDir: true }]
      : []),
    ...entries.map((entry) => ({
      key: entry.path,
      label: entry.name,
      href: entry.path,
      isDir: entry.type === "dir",
    })),
  ];

  if (rows.length === 0) {
    return (
      <ArtifactWorkspaceState
        variant="empty"
        title="Empty directory"
        description="This directory has no previewable entries."
      />
    );
  }

  return (
    <ul className="flex flex-col text-sm" aria-label={`Contents of ${path}`}>
      {rows.map((row) => {
        const Icon = row.isDir ? Folder : FileText;
        const isUp = row.key === "..";
        return (
          <li key={row.key}>
            <button
              type="button"
              disabled={!onOpenRepoFile}
              onClick={() => onOpenRepoFile?.(row.href)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors",
                onOpenRepoFile
                  ? "hover:bg-muted/60"
                  : "cursor-default opacity-70",
              )}
            >
              {isUp ? (
                <CornerLeftUp className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Icon
                  className={cn(
                    "size-4 shrink-0",
                    row.isDir ? "text-foreground" : "text-muted-foreground",
                  )}
                />
              )}
              <span className={cn("truncate", row.isDir && "font-medium")}>
                {row.label}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Metadata carried on the line-range highlight annotation. */
interface RepoFileAnnotationMetadata {
  lineRange: RepoFileLineRange;
}
type RepoFileLineAnnotation = {
  side: "deletions";
  lineNumber: number;
  metadata: RepoFileAnnotationMetadata;
};

/** Maps the action's opaque error category to a user-facing message. */
function describeErrorCategory(
  category: Extract<GetRepoFileContentResult, { status: "error" }>["category"],
): string {
  switch (category) {
    case "not-found":
      return "This file is not yet committed and pushed to the branch, so it cannot be previewed.";
    case "too-large":
      return "This file is too large to preview.";
    case "unsupported-content":
      return "This path is not a previewable file.";
    case "invalid-path":
      return "This link does not point to a valid repo file.";
    case "feature-disabled":
      return "Repo file preview is not enabled for your account.";
    case "unauthorized":
      return "You do not have access to this file.";
    case "github-error":
      return "Failed to load the file from the repository.";
  }
}

export function RepoFileArtifactRenderer({
  repoFilePart,
  threadId,
  onOpenRepoFile,
}: {
  repoFilePart: UIRepoFilePart;
  threadId?: string;
  onOpenRepoFile?: (href: string) => void;
}) {
  const { path, lineRange } = repoFilePart;
  const isMarkdown = isMarkdownFile(path);
  // Markdown defaults to the rendered view; non-markdown only has the source
  // (Pierre) view, so the toggle is hidden for it.
  const [showRawSource, setShowRawSource] = useState(false);
  const [state, setState] = useState<RepoFilePreviewState>({
    status: "loading",
  });

  useEffect(() => {
    if (!threadId) {
      setState({
        status: "error",
        message: "A thread is required to preview repo files.",
      });
      return;
    }

    // Capture the now-narrowed threadId so the async closure below sees a
    // non-null string without re-asserting it.
    const activeThreadId = threadId;
    const controller = new AbortController();

    // Reset to loading on every (threadId, path) change so a stale file's
    // content or error never lingers while the new fetch is in flight.
    setState({ status: "loading" });

    async function load() {
      try {
        const action = await getRepoFileContentAction({
          threadId: activeThreadId,
          path,
        });
        if (controller.signal.aborted) return;
        if (!action.success) {
          setState({ status: "error", message: action.errorMessage });
          return;
        }
        const result = action.data;
        if (result.status === "error") {
          setState({
            status: "error",
            message: describeErrorCategory(result.category),
          });
          return;
        }
        if (result.status === "directory") {
          setState({ status: "directory", entries: result.entries });
          return;
        }
        setState({ status: "ready", content: result.content });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Unable to load file preview.",
        });
      }
    }

    void load();
    return () => controller.abort();
  }, [threadId, path]);

  const patch = useMemo(
    () =>
      state.status === "ready"
        ? createNoChangePatch(path, state.content)
        : null,
    [state, path],
  );

  // A `#Lstart-Lend` anchor highlights the targeted line in the Pierre view by
  // anchoring a marker to the start line of the range (no-change patch lines are
  // all "unchanged" context, rendered on the deletions side).
  const lineAnnotations = useMemo<RepoFileLineAnnotation[] | undefined>(
    () =>
      lineRange
        ? [
            {
              side: "deletions" as const,
              lineNumber: lineRange.start,
              metadata: { lineRange },
            },
          ]
        : undefined,
    [lineRange],
  );

  const renderSource = !isMarkdown || showRawSource;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{path}</p>
          {lineRange && (
            <p className="text-xs text-muted-foreground">
              {lineRange.start === lineRange.end
                ? `Line ${lineRange.start}`
                : `Lines ${lineRange.start}–${lineRange.end}`}
            </p>
          )}
        </div>
        {isMarkdown && (
          <div
            role="group"
            aria-label="Markdown view mode"
            className="inline-flex shrink-0 rounded-md border bg-background text-xs"
          >
            <button
              type="button"
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded-l-md transition-colors",
                !showRawSource ? "bg-muted font-medium" : "hover:bg-muted/50",
              )}
              onClick={() => setShowRawSource(false)}
              aria-pressed={!showRawSource}
            >
              <FileText className="size-3" />
              Rendered
            </button>
            <button
              type="button"
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded-r-md transition-colors",
                showRawSource ? "bg-muted font-medium" : "hover:bg-muted/50",
              )}
              onClick={() => setShowRawSource(true)}
              aria-pressed={showRawSource}
            >
              <Code2 className="size-3" />
              Source
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {state.status === "loading" && (
          <ArtifactWorkspaceState
            variant="loading"
            title="Loading preview"
            description="Fetching file contents for preview."
          />
        )}
        {state.status === "error" && (
          <ArtifactWorkspaceState
            variant="error"
            title="Preview unavailable"
            description={state.message}
          />
        )}
        {state.status === "directory" && (
          <RepoDirectoryListing
            path={path}
            entries={state.entries}
            onOpenRepoFile={onOpenRepoFile}
          />
        )}
        {state.status === "ready" &&
          (renderSource ? (
            patch && (
              <HighlightedDiffView<RepoFileAnnotationMetadata>
                patch={patch}
                enableLineNumbers
                lineAnnotations={lineAnnotations}
                renderAnnotation={(annotation) => {
                  const range = annotation.metadata?.lineRange;
                  if (!range) return null;
                  return (
                    <div
                      className="border-y border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                      aria-label={
                        range.start === range.end
                          ? `Highlighted line ${range.start}`
                          : `Highlighted lines ${range.start}–${range.end}`
                      }
                    >
                      {range.start === range.end
                        ? `Line ${range.start}`
                        : `Lines ${range.start}–${range.end}`}
                    </div>
                  );
                }}
              />
            )
          ) : (
            <MarkdownRenderer
              content={state.content}
              streaming={false}
              onOpenFile={onOpenRepoFile}
            />
          ))}
      </div>
    </div>
  );
}

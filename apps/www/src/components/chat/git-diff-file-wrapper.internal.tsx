"use client";

import {
  type AnnotationSide,
  type DiffLineAnnotation,
  type DiffLineEventBaseProps,
} from "@pierre/diffs/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ImageDiffView } from "@/components/chat/image-diff-view";
import { DiffRenderer } from "@/components/shared/diff-renderer";
import { cn, formatBytes } from "@/lib/utils";
import { CommentWidget } from "./git-diff-comment-widget";
import type {
  CommentWidgetData,
  FileDiffWrapperProps,
} from "./git-diff-view.types";
import { getFileIcon } from "./git-diff-view.utils";

function useIsStuck(ref: React.RefObject<HTMLDivElement | null>) {
  const [isStuck, setIsStuck] = useState(false);
  useEffect(() => {
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          setIsStuck(!entry.isIntersecting);
        });
      },
      { threshold: 1 },
    );
    if (ref.current) {
      intersectionObserver.observe(ref.current);
    }
    return () => intersectionObserver.disconnect();
  }, [ref]);
  return isStuck;
}

/**
 * Wrapper component for displaying a single file diff
 */
export function FileDiffWrapper({
  parsedFile,
  mode,
  expanded,
  onToggle,
  thread,
  enableComments,
  threadChatId,
  threadMessages,
  forceUnified = false,
  isImageDiffViewEnabled = false,
}: FileDiffWrapperProps & { isImageDiffViewEnabled?: boolean }) {
  // Use unified mode for new files to avoid wide gutter, or if forced
  const effectiveMode =
    forceUnified || parsedFile.changeType === "added" ? "unified" : mode;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const isHeaderStuck = useIsStuck(sentinelRef);
  const [activeAnnotation, setActiveAnnotation] = useState<{
    lineNumber: number;
    side: AnnotationSide;
    isAddition: boolean;
  } | null>(null);

  // Only load text diff data for non-image files when image diff view is enabled
  // If feature flag is off, treat images as binary files and load text diff
  const isImage = isImageDiffViewEnabled && parsedFile.isImage;
  const lineAnnotations = useMemo<
    DiffLineAnnotation<CommentWidgetData>[]
  >(() => {
    if (!enableComments || activeAnnotation === null) return [];
    return [
      {
        side: activeAnnotation.side,
        lineNumber: activeAnnotation.lineNumber,
        metadata: {
          isAddition: activeAnnotation.isAddition,
        },
      },
    ];
  }, [activeAnnotation, enableComments]);

  const closeActiveAnnotation = () => setActiveAnnotation(null);

  const handleLineClick = ({
    annotationSide,
    lineNumber,
    lineType,
  }: DiffLineEventBaseProps) => {
    if (!enableComments) return;
    if (lineType !== "change-addition" && lineType !== "change-deletion") {
      return;
    }

    setActiveAnnotation((prev) => {
      const isAddition = annotationSide === "additions";
      if (prev?.lineNumber === lineNumber && prev.side === annotationSide) {
        return null;
      }
      return {
        lineNumber,
        side: annotationSide,
        isAddition,
      };
    });
  };

  // For images (when feature enabled), show binary badge instead of line counts
  const showLineCounts = !isImage && !parsedFile.isBinary;

  return (
    <div className="rounded-lg border bg-card shadow-sm">
      <div ref={sentinelRef} className="h-0" />
      <div
        className={cn(
          "font-mono text-xs font-medium flex items-center justify-between cursor-pointer select-none sticky top-0 z-10 bg-card transition-colors p-3 gap-2 rounded-lg",
          expanded && "rounded-b-none",
          isHeaderStuck && "rounded-t-none",
        )}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={parsedFile.fileName}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="flex items-center min-w-0 gap-2">
          {expanded ? (
            <ChevronDown className="w-4 h-4 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 flex-shrink-0" />
          )}
          {getFileIcon(parsedFile.changeType, isImage)}
          <span className="truncate-start">{parsedFile.fileName}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {showLineCounts ? (
            <>
              {parsedFile.additions > 0 && (
                <span className="text-green-600 dark:text-green-400 text-xs font-medium">
                  +{parsedFile.additions}
                </span>
              )}
              {parsedFile.deletions > 0 && (
                <span className="text-red-600 dark:text-red-400 text-xs font-medium">
                  -{parsedFile.deletions}
                </span>
              )}
            </>
          ) : isImage ? (
            <span className="text-xs font-medium">
              {parsedFile.changeType === "added" ? (
                <span className="text-green-600 dark:text-green-400">
                  {parsedFile.newFileSize !== undefined
                    ? `+${formatBytes(parsedFile.newFileSize)}`
                    : "New image"}
                </span>
              ) : parsedFile.changeType === "deleted" ? (
                <span className="text-red-600 dark:text-red-400">
                  {parsedFile.oldFileSize !== undefined
                    ? `-${formatBytes(parsedFile.oldFileSize)}`
                    : "Deleted image"}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {parsedFile.oldFileSize !== undefined &&
                  parsedFile.newFileSize !== undefined
                    ? `${formatBytes(parsedFile.oldFileSize)} → ${formatBytes(parsedFile.newFileSize)}`
                    : "Image"}
                </span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">Binary</span>
          )}
        </div>
      </div>
      {expanded &&
        (isImage ? (
          <div className="bg-background overflow-hidden rounded-b-lg">
            <ImageDiffView
              fileName={parsedFile.fileName}
              changeType={parsedFile.changeType}
              repoFullName={thread.githubRepoFullName}
              baseBranchName={thread.repoBaseBranchName}
              headBranchName={thread.branchName ?? thread.repoBaseBranchName}
            />
          </div>
        ) : (
          <div className="bg-background overflow-hidden rounded-b-lg">
            <DiffRenderer<CommentWidgetData>
              patch={parsedFile.fullDiff}
              mode={effectiveMode === "split" ? "split" : "unified"}
              enableLineNumbers
              enableFileHeader
              onLineClick={enableComments ? handleLineClick : undefined}
              lineAnnotations={lineAnnotations}
              renderAnnotation={(annotation) => (
                <CommentWidget
                  side={annotation.side === "additions" ? 2 : 1}
                  lineNumber={annotation.lineNumber}
                  onClose={closeActiveAnnotation}
                  fileName={parsedFile.fileName}
                  thread={thread}
                  threadChatId={threadChatId}
                  threadMessages={threadMessages}
                  isAddition={annotation.metadata?.isAddition ?? false}
                />
              )}
            />
          </div>
        ))}
    </div>
  );
}

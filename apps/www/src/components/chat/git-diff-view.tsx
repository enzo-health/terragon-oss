"use client";

import React, { useEffect, useId, useMemo, useState } from "react";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { parseMultiFileDiff } from "@/lib/git-diff";
import { cn } from "@/lib/utils";
import { FileDiffWrapper } from "./git-diff-file-wrapper";
import { FileTreeItem } from "./git-diff-file-tree-item";
import { FilesChangedHeader } from "./git-diff-files-changed-header";
import type { GitDiffViewProps } from "./git-diff-view.types";
import {
  buildFileTree,
  collectAllFolders,
  computeDefaultExpanded,
} from "./git-diff-view.utils";

export { FilesChangedHeader } from "./git-diff-files-changed-header";
export { FileDiffWrapper } from "./git-diff-file-wrapper";

export function GitDiffView({
  thread,
  enableComments = false,
  diffPart,
  threadChatId,
  threadMessages,
}: GitDiffViewProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const fileTreeId = useId();
  const [isSmallScreen, setIsSmallScreen] = useState(false);
  const [isWideScreen, setIsWideScreen] = useState(false);
  const isImageDiffViewEnabled = useFeatureFlag("imageDiffView");

  const [viewMode, setViewMode] = useState<"split" | "unified">("unified");
  const [manuallySelectedMode, setManuallySelectedMode] = useState(false);
  const [showFileTree, setShowFileTree] = useState(true);

  // Check screen size on mount and resize
  React.useEffect(() => {
    const checkSize = () => {
      if (containerRef.current) {
        const width = containerRef.current.offsetWidth;
        setIsSmallScreen(width < 768);
        setIsWideScreen(width >= 900);
      }
    };

    checkSize();
    const observer = new ResizeObserver(checkSize);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, []);

  // Collapse file tree by default when first becoming small screen
  // Only run when isSmallScreen changes, not when showFileTree changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally only react to isSmallScreen
  React.useEffect(() => {
    if (isSmallScreen && showFileTree) {
      setShowFileTree(false);
    }
  }, [isSmallScreen]);

  // Auto-switch to split mode on wide screens (unless manually selected unified)
  React.useEffect(() => {
    if (isWideScreen && !manuallySelectedMode && viewMode === "unified") {
      setViewMode("split");
    }
  }, [isWideScreen, manuallySelectedMode, viewMode]);

  // Force unified mode on small screens
  const effectiveViewMode = isSmallScreen ? "unified" : viewMode;
  const activeDiff = diffPart?.diff ?? thread.gitDiff;
  // When rendering a specific diffPart (e.g. checkpoint), use only its stats —
  // don't fall back to thread.gitDiffStats which reflects the live working tree.
  // headerStats will fall back to computedDiffStats if activeDiffStats is undefined.
  const activeDiffStats = diffPart ? diffPart.diffStats : thread.gitDiffStats;

  const diffInstances = useMemo(() => {
    if (!activeDiff || activeDiff === "too-large") return [];

    try {
      return parseMultiFileDiff(activeDiff);
    } catch (e) {
      console.error("Failed to create diff instances:", e);
      return [];
    }
  }, [activeDiff]);

  const fileTree = useMemo(() => buildFileTree(diffInstances), [diffInstances]);

  const [expanded, setExpanded] = useState<Record<number, boolean>>(() =>
    computeDefaultExpanded(diffInstances),
  );

  const [selectedFile, setSelectedFile] = useState<number | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() =>
    collectAllFolders(fileTree),
  );

  // Reinitialise UI state when the diff content changes (e.g. switching
  // between diff artifacts in the secondary panel). useState initialisers
  // only run on mount, so subsequent diffInstances/fileTree changes would
  // otherwise leave stale expansion/selection state.
  useEffect(() => {
    setExpanded(computeDefaultExpanded(diffInstances));
    setSelectedFile(null);
  }, [diffInstances]);

  useEffect(() => {
    setExpandedFolders(collectAllFolders(fileTree));
  }, [fileTree]);

  const toggle = (idx: number) => {
    setExpanded((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  const toggleAll = (expand: boolean) => {
    const newExpanded: Record<number, boolean> = {};
    diffInstances.forEach((_, idx) => {
      newExpanded[idx] = expand;
    });
    setExpanded(newExpanded);
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const scrollToFile = (index: number) => {
    setSelectedFile(index);
    const element = document.getElementById(`file-diff-${index}`);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    // Close file tree on small screens after selecting a file
    if (isSmallScreen) {
      setShowFileTree(false);
    }
  };

  const allExpanded = diffInstances.every((_, idx) => expanded[idx]);

  // Calculate total additions and deletions
  const computedDiffStats = useMemo(() => {
    const totals = diffInstances.reduce(
      (acc, file) => ({
        additions: acc.additions + (file.additions ?? 0),
        deletions: acc.deletions + (file.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 },
    );

    return { ...totals, files: diffInstances.length };
  }, [diffInstances]);

  const headerStats = useMemo(() => {
    const stats = activeDiffStats;

    return {
      files: stats?.files ?? computedDiffStats.files,
      additions: stats?.additions ?? computedDiffStats.additions,
      deletions: stats?.deletions ?? computedDiffStats.deletions,
    };
  }, [activeDiffStats, computedDiffStats]);

  // Handle manual view mode change
  const handleViewModeChange = (mode: "split" | "unified") => {
    setViewMode(mode);
    setManuallySelectedMode(true);
  };

  if (!activeDiff) {
    return (
      <div ref={containerRef} className="flex flex-col h-full">
        <div className="border-b">
          <FilesChangedHeader
            fileCount={headerStats.files}
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            allExpanded={false}
            onToggleAll={() => {}}
            showFileTree={showFileTree}
            onToggleFileTree={() => setShowFileTree(!showFileTree)}
            additions={headerStats.additions}
            deletions={headerStats.deletions}
            isSmallScreen={isSmallScreen}
            fileTreeId={fileTreeId}
          />
        </div>
        <div className="flex items-center justify-center text-muted-foreground/50 py-8">
          No changes
        </div>
      </div>
    );
  }

  if (diffInstances.length === 0) {
    return (
      <div ref={containerRef} className="flex flex-col h-full">
        <div className="border-b">
          <FilesChangedHeader
            fileCount={headerStats.files}
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            allExpanded={false}
            onToggleAll={() => {}}
            showFileTree={showFileTree}
            onToggleFileTree={() => setShowFileTree(!showFileTree)}
            additions={headerStats.additions}
            deletions={headerStats.deletions}
            isSmallScreen={isSmallScreen}
            fileTreeId={fileTreeId}
          />
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          No diff data available
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      <div className="border-b">
        <FilesChangedHeader
          fileCount={headerStats.files}
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          allExpanded={allExpanded}
          onToggleAll={() => toggleAll(!allExpanded)}
          showFileTree={showFileTree}
          onToggleFileTree={() => setShowFileTree(!showFileTree)}
          additions={headerStats.additions}
          deletions={headerStats.deletions}
          isSmallScreen={isSmallScreen}
          fileTreeId={fileTreeId}
        />
      </div>
      <div className="flex flex-1 overflow-hidden relative">
        {/* Backdrop overlay on small screens */}
        {showFileTree && isSmallScreen && (
          <div
            className="absolute inset-0 bg-foreground/50 z-30"
            onClick={() => setShowFileTree(false)}
          />
        )}

        {/* File tree sidebar */}
        {showFileTree && (
          <div
            id={fileTreeId}
            className={cn(
              "w-64 border-r overflow-y-auto flex-shrink-0 bg-background",
              isSmallScreen && "absolute inset-y-0 left-0 z-40 shadow-lg",
            )}
            aria-label="Changed files"
          >
            <div className="p-2">
              {fileTree.map((node) => (
                <FileTreeItem
                  key={node.path}
                  node={node}
                  selectedFile={selectedFile}
                  onFileSelect={scrollToFile}
                  expandedFolders={expandedFolders}
                  onToggleFolder={toggleFolder}
                />
              ))}
            </div>
          </div>
        )}

        {/* Diff view */}
        <div className="flex-1 overflow-auto">
          <div className="git-diff-view-wrapper flex flex-col gap-3 p-3">
            {diffInstances.map((parsedFile, index) => (
              <div key={index} id={`file-diff-${index}`}>
                <FileDiffWrapper
                  parsedFile={parsedFile}
                  mode={effectiveViewMode}
                  expanded={!!expanded[index]}
                  onToggle={() => toggle(index)}
                  thread={thread}
                  enableComments={enableComments}
                  threadChatId={threadChatId}
                  threadMessages={threadMessages}
                  isImageDiffViewEnabled={isImageDiffViewEnabled}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

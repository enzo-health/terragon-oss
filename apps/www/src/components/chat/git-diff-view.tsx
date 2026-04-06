"use client";

import {
  type AnnotationSide,
  type DiffLineAnnotation,
  type DiffLineEventBaseProps,
} from "@pierre/diffs/react";
import type { DBMessage, DBUserMessage } from "@terragon/shared";
import { ThreadInfoFull, type UIGitDiffPart } from "@terragon/shared";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileDiff,
  FilePlus,
  FileX,
  Folder,
  Image,
  PanelLeft,
  PanelLeftClose,
  X,
} from "lucide-react";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ImageDiffView } from "@/components/chat/image-diff-view";
import { GenericPromptBox } from "@/components/promptbox/generic-promptbox";
import { DiffRenderer } from "@/components/shared/diff-renderer";
import { DiffModeToggle } from "@/components/shared/diff-view";
import { Button } from "@/components/ui/button";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { convertToPlainText } from "@/lib/db-message-helpers";
import {
  type FileChangeType,
  type ParsedDiffFile,
  parseMultiFileDiff,
} from "@/lib/git-diff";
import { cn, formatBytes } from "@/lib/utils";
import { followUp } from "@/server-actions/follow-up";
import { useOptimisticUpdateThreadChat } from "./hooks";

interface GitDiffViewProps {
  thread: ThreadInfoFull;
  mode?: "split" | "unified";
  enableComments?: boolean;
  diffPart?: UIGitDiffPart;
  threadChatId?: string;
  threadMessages?: DBMessage[];
}

interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileTreeNode[];
  fileIndex?: number;
  additions?: number;
  deletions?: number;
  changeType?: FileChangeType;
  isImage?: boolean;
}

function buildFileTree(files: ParsedDiffFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  files.forEach((file, index) => {
    const parts = file.fileName.split("/");
    let currentLevel = root;

    parts.forEach((part, partIndex) => {
      const isFile = partIndex === parts.length - 1;
      const existingNode = currentLevel.find((node) => node.name === part);

      if (existingNode) {
        if (!isFile && existingNode.children) {
          currentLevel = existingNode.children;
        }
      } else {
        const newNode: FileTreeNode = {
          name: part,
          path: parts.slice(0, partIndex + 1).join("/"),
          type: isFile ? "file" : "folder",
          ...(isFile && {
            fileIndex: index,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.changeType,
            isImage: file.isImage,
          }),
          ...(!isFile && { children: [] }),
        };

        currentLevel.push(newNode);

        if (!isFile && newNode.children) {
          currentLevel = newNode.children;
        }
      }
    });
  });

  return root;
}

/**
 * Returns the appropriate icon for a file change type
 */
function getFileIcon(changeType: FileChangeType, isImage: boolean = false) {
  if (isImage) {
    const colorClass =
      changeType === "added"
        ? "text-green-600 dark:text-green-400"
        : changeType === "deleted"
          ? "text-red-600 dark:text-red-400"
          : "text-neutral-600 dark:text-neutral-400";
    return <Image className={cn("w-4 h-4 flex-shrink-0", colorClass)} />;
  }

  switch (changeType) {
    case "added":
      return (
        <FilePlus className="w-4 h-4 flex-shrink-0 text-green-600 dark:text-green-400" />
      );
    case "deleted":
      return (
        <FileX className="w-4 h-4 flex-shrink-0 text-red-600 dark:text-red-400" />
      );
    case "modified":
      return (
        <FileDiff className="w-4 h-4 flex-shrink-0 text-neutral-600 dark:text-neutral-400" />
      );
  }
}

interface FileDiffWrapperProps {
  parsedFile: ParsedDiffFile;
  mode: "split" | "unified";
  expanded: boolean;
  onToggle: () => void;
  thread: ThreadInfoFull;
  enableComments: boolean;
  threadChatId?: string;
  threadMessages?: DBMessage[];
  forceUnified?: boolean;
}

interface CommentWidgetData {
  isAddition: boolean;
}

/**
 * Comment widget component
 */
interface CommentWidgetProps {
  side: 1 | 2; // SplitSide enum: 1 = old, 2 = new
  lineNumber: number;
  onClose: () => void;
  fileName: string;
  thread: ThreadInfoFull;
  threadChatId?: string;
  threadMessages?: DBMessage[];
  isAddition: boolean;
}

function CommentWidget({
  side,
  lineNumber,
  onClose,
  fileName,
  thread,
  threadChatId,
  threadMessages,
  isAddition,
}: CommentWidgetProps) {
  const updateThreadChat = useOptimisticUpdateThreadChat({
    threadId: thread.id,
    threadChatId,
  });
  const emptyMessage: DBUserMessage = {
    type: "user",
    parts: [{ type: "text", text: "" }],
    model: null,
  };
  const handleSubmit = async ({
    userMessage,
  }: {
    userMessage: DBUserMessage;
  }) => {
    if (!threadChatId || !threadMessages) return;
    const plainText = convertToPlainText({ message: userMessage });
    if (plainText.length === 0) return;

    const sideLabel = isAddition ? "new" : "old";
    const contextPrefix = `[Comment on ${fileName} line ${lineNumber} (${sideLabel})]\n\n`;
    const contextualMessage: DBUserMessage = {
      ...userMessage,
      parts: [{ type: "text", text: contextPrefix }, ...userMessage.parts],
    };

    // Optimistic update
    updateThreadChat({
      messages: [...threadMessages, contextualMessage],
      errorMessage: null,
      errorMessageInfo: null,
      status: "booting",
    });

    onClose();

    await followUp({
      threadId: thread.id,
      threadChatId,
      message: contextualMessage,
    });
  };
  return (
    <div
      className={cn(
        "p-4 font-sans",
        isAddition
          ? "bg-green-50 dark:bg-green-950/20"
          : "bg-red-50 dark:bg-red-950/20",
      )}
    >
      <div className="bg-background border rounded-lg shadow-sm p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted-foreground">
            Add a comment on this line
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-6 w-6 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <GenericPromptBox
          message={emptyMessage}
          repoFullName={thread.githubRepoFullName}
          branchName={thread.branchName ?? thread.repoBaseBranchName}
          forcedAgent={null}
          forcedAgentVersion={null}
          onSubmit={handleSubmit}
          placeholder="Leave a comment..."
          autoFocus={true}
          hideSubmitButton={false}
          clearContentOnSubmit={true}
          hideModelSelector={true}
          hideModeSelector={true}
          hideAddContextButton={true}
          hideFileAttachmentButton={true}
          hideVoiceInput={false}
        />
      </div>
    </div>
  );
}

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
function FileDiffWrapper({
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

export function FilesChangedHeader({
  fileCount,
  viewMode,
  onViewModeChange,
  allExpanded,
  onToggleAll,
  showFileTree,
  onToggleFileTree,
  additions,
  deletions,
  isSmallScreen,
  fileTreeId,
}: {
  fileCount: number;
  viewMode: "split" | "unified";
  onViewModeChange: (mode: "split" | "unified") => void;
  allExpanded: boolean;
  onToggleAll: () => void;
  showFileTree: boolean;
  onToggleFileTree: () => void;
  additions: number;
  deletions: number;
  isSmallScreen: boolean;
  fileTreeId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-accent/30">
      <div className="flex items-center gap-2 min-w-0 overflow-hidden flex-1">
        <span className="text-[12px] font-medium text-foreground/80 whitespace-nowrap">
          {fileCount} file{fileCount !== 1 ? "s" : ""}
        </span>
        {(additions > 0 || deletions > 0) && (
          <div className="flex items-center gap-1.5 text-[11px] font-medium flex-shrink-0">
            {additions > 0 && (
              <span className="text-green-600 dark:text-green-400">
                +{additions}
              </span>
            )}
            {deletions > 0 && (
              <span className="text-red-600 dark:text-red-400">
                -{deletions}
              </span>
            )}
          </div>
        )}
      </div>
      {fileCount > 0 && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={onToggleFileTree}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-muted transition-colors"
            title={showFileTree ? "Hide file tree" : "Show file tree"}
            aria-label={
              showFileTree ? "Hide changed files" : "Show changed files"
            }
            aria-expanded={showFileTree}
            aria-controls={fileTreeId}
          >
            {showFileTree ? (
              <PanelLeftClose className="w-3.5 h-3.5" />
            ) : (
              <PanelLeft className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onToggleAll}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-muted transition-colors"
            title={allExpanded ? "Collapse all" : "Expand all"}
            aria-label={allExpanded ? "Collapse all files" : "Expand all files"}
            aria-pressed={allExpanded}
          >
            {allExpanded ? (
              <ChevronsDownUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronsUpDown className="w-3.5 h-3.5" />
            )}
            <span className="hidden sm:inline">
              {allExpanded ? "Collapse" : "Expand"}
            </span>
          </button>
          {!isSmallScreen && (
            <DiffModeToggle
              mode={viewMode}
              onModeChange={onViewModeChange}
              className="py-0.5 px-0.5"
            />
          )}
        </div>
      )}
    </div>
  );
}

function FileTreeItem({
  node,
  depth = 0,
  selectedFile,
  onFileSelect,
  expandedFolders,
  onToggleFolder,
}: {
  node: FileTreeNode;
  depth?: number;
  selectedFile: number | null;
  onFileSelect: (index: number) => void;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
}) {
  const isFolder = node.type === "folder";
  const isExpanded = expandedFolders.has(node.path);
  const isSelected =
    node.fileIndex !== undefined && node.fileIndex === selectedFile;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded",
          isSelected && "bg-neutral-200 dark:bg-neutral-700",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        role="button"
        tabIndex={0}
        aria-expanded={isFolder ? isExpanded : undefined}
        aria-pressed={!isFolder ? isSelected : undefined}
        aria-label={node.name}
        onClick={() => {
          if (isFolder) {
            onToggleFolder(node.path);
          } else if (node.fileIndex !== undefined) {
            onFileSelect(node.fileIndex);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (isFolder) {
              onToggleFolder(node.path);
            } else if (node.fileIndex !== undefined) {
              onFileSelect(node.fileIndex);
            }
          }
        }}
      >
        {isFolder ? (
          <>
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 flex-shrink-0" />
            ) : (
              <ChevronRight className="w-4 h-4 flex-shrink-0" />
            )}
            <Folder className="w-4 h-4 flex-shrink-0" />
          </>
        ) : (
          <div className="ml-4 flex-shrink-0">
            {node.changeType && getFileIcon(node.changeType, node.isImage)}
          </div>
        )}
        <span className="truncate">{node.name}</span>
      </div>
      {isFolder && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onFileSelect={onFileSelect}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function computeDefaultExpanded(
  diffInstances: ParsedDiffFile[],
): Record<number, boolean> {
  return diffInstances.reduce(
    (acc, file, idx) => {
      const totalChanges = (file.additions ?? 0) + (file.deletions ?? 0);
      acc[idx] = diffInstances.length === 1 || totalChanges < 200;
      return acc;
    },
    {} as Record<number, boolean>,
  );
}

function collectAllFolders(fileTree: FileTreeNode[]): Set<string> {
  const folders = new Set<string>();
  const walk = (nodes: FileTreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "folder") {
        folders.add(node.path);
        if (node.children) walk(node.children);
      }
    }
  };
  walk(fileTree);
  return folders;
}

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
            className="absolute inset-0 bg-black/50 z-30"
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

// Export FileDiffWrapper for use in other components
export { FileDiffWrapper };

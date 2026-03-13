"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  type AnnotationSide,
  type DiffLineEventBaseProps,
  type DiffLineAnnotation,
} from "@pierre/diffs/react";
import { useTheme } from "next-themes";

const PatchDiff = dynamic(
  () => import("@pierre/diffs/react").then((mod) => mod.PatchDiff),
  { ssr: false },
);
import {
  ChevronRight,
  ChevronDown,
  FileDiff,
  Folder,
  FilePlus,
  FileX,
  ChevronsDownUp,
  ChevronsUpDown,
  PanelLeft,
  PanelLeftClose,
  X,
  Image,
} from "lucide-react";
import { ThreadInfoFull } from "@terragon/shared";
import { cn } from "@/lib/utils";
import {
  parseMultiFileDiff,
  type FileChangeType,
  type ParsedDiffFile,
} from "@/lib/git-diff";
import { Button } from "@/components/ui/button";
import type { DBMessage, DBUserMessage } from "@terragon/shared";
import { GenericPromptBox } from "@/components/promptbox/generic-promptbox";
import { ImageDiffView } from "@/components/chat/image-diff-view";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { followUp } from "@/server-actions/follow-up";
import { useOptimisticUpdateThreadChat } from "./hooks";
import { convertToPlainText } from "@/lib/db-message-helpers";

/**
 * Formats file size in bytes to human-readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

interface GitDiffViewProps {
  thread: ThreadInfoFull;
  mode?: "split" | "unified";
  enableComments?: boolean;
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
  theme: string | undefined;
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
  theme,
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

  const getLineTheme = useMemo(() => {
    if (theme === "light") return "pierre-light";
    if (theme === "dark") return "pierre-dark";
    return "pierre-dark";
  }, [theme]);

  const themeType = useMemo(() => {
    if (theme === "light") return "light";
    if (theme === "dark") return "dark";
    return "system";
  }, [theme]);

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
        onClick={onToggle}
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
                    ? `+${formatFileSize(parsedFile.newFileSize)}`
                    : "New image"}
                </span>
              ) : parsedFile.changeType === "deleted" ? (
                <span className="text-red-600 dark:text-red-400">
                  {parsedFile.oldFileSize !== undefined
                    ? `-${formatFileSize(parsedFile.oldFileSize)}`
                    : "Deleted image"}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {parsedFile.oldFileSize !== undefined &&
                  parsedFile.newFileSize !== undefined
                    ? `${formatFileSize(parsedFile.oldFileSize)} → ${formatFileSize(parsedFile.newFileSize)}`
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
            <PatchDiff
              patch={parsedFile.fullDiff}
              options={{
                diffStyle: effectiveMode === "split" ? "split" : "unified",
                overflow: "wrap",
                theme: getLineTheme,
                themeType,
                onLineClick: enableComments ? handleLineClick : undefined,
              }}
              lineAnnotations={lineAnnotations}
              renderAnnotation={(
                annotation: DiffLineAnnotation<CommentWidgetData>,
              ) => (
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
              style={
                {
                  "--diffs-font-size": "12px",
                } as React.CSSProperties
              }
            />
          </div>
        ))}
    </div>
  );
}

function FilesChangedHeader({
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
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0 overflow-hidden flex-1">
        <div className="flex items-center gap-2 flex-shrink-0">
          <FileDiff className="size-4 flex-shrink-0" />
          <h2 className="text-sm font-medium whitespace-nowrap">
            Files Changed
          </h2>
          {fileCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 text-xs font-medium rounded-full bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-200 flex-shrink-0">
              {fileCount}
            </span>
          )}
        </div>
        {(additions > 0 || deletions > 0) && (
          <div className="flex items-center gap-2 text-xs font-medium flex-shrink-0 min-w-0">
            {additions > 0 && (
              <span className="flex items-center gap-1 text-green-600 dark:text-green-400 whitespace-nowrap">
                <span>+{additions}</span>
              </span>
            )}
            {deletions > 0 && (
              <span className="flex items-center gap-1 text-red-600 dark:text-red-400 whitespace-nowrap">
                <span>-{deletions}</span>
              </span>
            )}
          </div>
        )}
      </div>
      {fileCount > 0 && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onToggleFileTree}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-muted transition-colors"
            title={showFileTree ? "Hide file tree" : "Show file tree"}
          >
            {showFileTree ? (
              <PanelLeftClose className="w-3.5 h-3.5" />
            ) : (
              <PanelLeft className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={onToggleAll}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-muted transition-colors"
            title={allExpanded ? "Collapse all" : "Expand all"}
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
            <div className="flex items-center rounded-md border bg-background">
              <button
                onClick={() => onViewModeChange("unified")}
                className={cn(
                  "px-2.5 py-1.5 text-xs font-medium transition-colors rounded-l-md",
                  viewMode === "unified" ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                Unified
              </button>
              <button
                onClick={() => onViewModeChange("split")}
                className={cn(
                  "px-2.5 py-1.5 text-xs font-medium transition-colors rounded-r-md",
                  viewMode === "split" ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                Split
              </button>
            </div>
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
        onClick={() => {
          if (isFolder) {
            onToggleFolder(node.path);
          } else if (node.fileIndex !== undefined) {
            onFileSelect(node.fileIndex);
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

export function GitDiffView({
  thread,
  enableComments = false,
  threadChatId,
  threadMessages,
}: GitDiffViewProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isSmallScreen, setIsSmallScreen] = useState(false);
  const [isWideScreen, setIsWideScreen] = useState(false);
  const { resolvedTheme } = useTheme();
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

  const diffInstances = useMemo(() => {
    if (!thread.gitDiff || thread.gitDiff === "too-large") return [];

    try {
      return parseMultiFileDiff(thread.gitDiff);
    } catch (e) {
      console.error("Failed to create diff instances:", e);
      return [];
    }
  }, [thread.gitDiff]);

  const fileTree = useMemo(() => buildFileTree(diffInstances), [diffInstances]);

  const [expanded, setExpanded] = useState<Record<number, boolean>>(() => {
    return diffInstances.reduce(
      (acc, file, idx) => {
        const totalChanges = (file.additions ?? 0) + (file.deletions ?? 0);
        const shouldExpandDiff =
          diffInstances.length === 1 || totalChanges < 200;
        acc[idx] = shouldExpandDiff;
        return acc;
      },
      {} as Record<number, boolean>,
    );
  });

  const [selectedFile, setSelectedFile] = useState<number | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    // Expand all folders by default
    const folders = new Set<string>();
    const collectFolders = (nodes: FileTreeNode[], parentPath = "") => {
      nodes.forEach((node) => {
        if (node.type === "folder") {
          folders.add(node.path);
          if (node.children) {
            collectFolders(node.children, node.path);
          }
        }
      });
    };
    collectFolders(fileTree);
    return folders;
  });

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
    const stats = thread.gitDiffStats;

    return {
      files: stats?.files ?? computedDiffStats.files,
      additions: stats?.additions ?? computedDiffStats.additions,
      deletions: stats?.deletions ?? computedDiffStats.deletions,
    };
  }, [thread.gitDiffStats, computedDiffStats]);

  // Handle manual view mode change
  const handleViewModeChange = (mode: "split" | "unified") => {
    setViewMode(mode);
    setManuallySelectedMode(true);
  };

  if (!thread.gitDiff) {
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
            className={cn(
              "w-64 border-r overflow-y-auto flex-shrink-0 bg-background",
              isSmallScreen && "absolute inset-y-0 left-0 z-40 shadow-lg",
            )}
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
                  theme={resolvedTheme}
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

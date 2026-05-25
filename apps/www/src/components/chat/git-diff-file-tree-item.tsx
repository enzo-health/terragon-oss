"use client";

import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import React from "react";
import { cn } from "@/lib/utils";
import type { FileTreeNode } from "./git-diff-view.types";
import {
  getFileIcon,
  resolveFileTreeItemActivation,
} from "./git-diff-view.utils";

export function FileTreeItem({
  node,
  depth = 0,
  selectedFile,
  onFileSelect,
  expandedFolders,
  onToggleFolder,
  onOpenRepoFile,
}: {
  node: FileTreeNode;
  depth?: number;
  selectedFile: number | null;
  onFileSelect: (index: number) => void;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  // When provided, activating a leaf file routes its repo-relative path to the
  // s3 open-repo-file flow instead of scrolling/selecting in place. Absent =>
  // unchanged behavior (flag off).
  onOpenRepoFile?: (path: string, preferArtifactId?: string) => void;
}) {
  const isFolder = node.type === "folder";
  const isExpanded = expandedFolders.has(node.path);
  const isSelected =
    node.fileIndex !== undefined && node.fileIndex === selectedFile;

  const activate = () => {
    const action = resolveFileTreeItemActivation(node, !!onOpenRepoFile);
    switch (action.kind) {
      case "toggle-folder":
        onToggleFolder(action.path);
        break;
      case "select-file":
        onFileSelect(action.fileIndex);
        break;
      case "open-repo-file":
        onOpenRepoFile?.(action.path);
        break;
      case "none":
        break;
    }
  };

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-muted rounded transition-colors",
          isSelected && "bg-accent text-accent-foreground",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        role="button"
        tabIndex={0}
        data-open-repo-file={!isFolder && !!onOpenRepoFile ? "true" : undefined}
        aria-expanded={isFolder ? isExpanded : undefined}
        // In open-repo-file mode activating a leaf opens the artifact rather
        // than toggling selection, so the toggle-button (pressed-state)
        // semantics no longer apply — only expose aria-pressed when the row
        // actually toggles in-place selection.
        aria-pressed={!isFolder && !onOpenRepoFile ? isSelected : undefined}
        aria-label={
          !isFolder && onOpenRepoFile ? `Open ${node.name}` : node.name
        }
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
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
              onOpenRepoFile={onOpenRepoFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

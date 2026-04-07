"use client";

import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileTreeNode } from "./git-diff-view.types";
import { getFileIcon } from "./git-diff-view.utils";

export function FileTreeItem({
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

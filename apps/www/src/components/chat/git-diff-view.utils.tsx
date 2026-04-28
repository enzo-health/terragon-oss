import React from "react";
import { FileDiff, FilePlus, FileX, Image } from "lucide-react";
import type { FileChangeType, ParsedDiffFile } from "@/lib/git-diff";
import { cn } from "@/lib/utils";
import type { FileTreeNode } from "./git-diff-view.types";

export function buildFileTree(files: ParsedDiffFile[]): FileTreeNode[] {
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
 * Returns the appropriate icon for a file change type, or `undefined` if the
 * `changeType` does not match any known case (defensive against future
 * additions to `FileChangeType`).
 */
export function getFileIcon(
  changeType: FileChangeType,
  isImage: boolean = false,
): React.ReactElement | undefined {
  if (isImage) {
    const colorClass =
      changeType === "added"
        ? "text-[var(--diff-added-fg)]"
        : changeType === "deleted"
          ? "text-[var(--diff-removed-fg)]"
          : "text-muted-foreground";
    return <Image className={cn("w-4 h-4 flex-shrink-0", colorClass)} />;
  }

  switch (changeType) {
    case "added":
      return (
        <FilePlus className="w-4 h-4 flex-shrink-0 text-[var(--diff-added-fg)]" />
      );
    case "deleted":
      return (
        <FileX className="w-4 h-4 flex-shrink-0 text-[var(--diff-removed-fg)]" />
      );
    case "modified":
      return (
        <FileDiff className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
      );
  }
}

export function computeDefaultExpanded(
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

export function collectAllFolders(fileTree: FileTreeNode[]): Set<string> {
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

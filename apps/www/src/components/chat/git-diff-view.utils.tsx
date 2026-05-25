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

export type FileTreeItemActivation =
  | { kind: "toggle-folder"; path: string }
  | { kind: "select-file"; fileIndex: number }
  | { kind: "open-repo-file"; path: string }
  | { kind: "none" };

/**
 * Pure decision for what activating (click / Enter / Space) a file-tree node
 * does. When `openRepoFileEnabled` is true, activating a leaf file routes the
 * path to the s3 open-repo-file flow instead of the in-place scroll/select.
 * Folders always toggle. Keeping this pure lets the click path be unit-tested
 * without a DOM event simulator.
 */
export function resolveFileTreeItemActivation(
  node: FileTreeNode,
  openRepoFileEnabled: boolean,
): FileTreeItemActivation {
  if (node.type === "folder") {
    return { kind: "toggle-folder", path: node.path };
  }
  if (node.fileIndex === undefined) {
    return { kind: "none" };
  }
  if (openRepoFileEnabled) {
    return { kind: "open-repo-file", path: node.path };
  }
  return { kind: "select-file", fileIndex: node.fileIndex };
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

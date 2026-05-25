"use client";

import { prepareFileTreeInput, type GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { ThreadInfoFull } from "@terragon/shared";
import type { GetRepoTreeResult } from "@/server-actions/get-repo-tree";
import { useEffect, useMemo, useRef } from "react";
import { parseMultiFileDiff } from "@/lib/git-diff";
import { useRepoTreeQuery } from "@/queries/repo-tree";
import { ArtifactWorkspaceState } from "./secondary-panel-state";

type RepoTreeErrorCategory = Extract<
  GetRepoTreeResult,
  { status: "error" }
>["category"];

/** Opaque category → user-facing message. Mirrors the repo-file renderer. */
function describeRepoTreeError(category: RepoTreeErrorCategory): string {
  switch (category) {
    case "not-found":
      return "This branch has no files to list, or it has not been pushed.";
    case "feature-disabled":
      return "Repo file preview is not enabled for your account.";
    case "unauthorized":
      return "You do not have access to this repository.";
    case "github-error":
      return "Failed to load the file tree from the repository.";
  }
}

/** Maps the thread diff to Pierre git-status entries so changed files are
 * colored. `parseMultiFileDiff`'s change type is a subset of Pierre's. */
function gitStatusFromThreadDiff(
  gitDiff: ThreadInfoFull["gitDiff"],
): GitStatusEntry[] {
  if (!gitDiff || gitDiff === "too-large") return [];
  return parseMultiFileDiff(gitDiff).map((file) => ({
    path: file.fileName,
    status: file.changeType,
  }));
}

export function RepoTreeArtifactRenderer({
  threadId,
  thread,
  activeRepoFilePath,
  onOpenRepoFile,
}: {
  threadId?: string;
  thread: ThreadInfoFull;
  /** Path of the file currently open in the preview, highlighted in the tree. */
  activeRepoFilePath?: string | null;
  onOpenRepoFile?: (path: string) => void;
}) {
  // Callbacks/data the once-created model's listeners read through refs, so the
  // model never needs to be rebuilt when props or fetched data change.
  const onOpenRef = useRef(onOpenRepoFile);
  onOpenRef.current = onOpenRepoFile;
  const fileSetRef = useRef<Set<string>>(new Set());

  const query = useRepoTreeQuery(threadId);
  const result = query.data;

  const gitStatus = useMemo(
    () => gitStatusFromThreadDiff(thread.gitDiff),
    [thread.gitDiff],
  );

  // Create the model exactly once. Selecting a file row opens it; directory
  // rows (paths not in the file set) just toggle expansion and are ignored.
  const { model } = useFileTree(
    useMemo(
      () => ({
        paths: [] as string[],
        initialExpansion: "closed" as const,
        onSelectionChange: (paths: readonly string[]) => {
          const path = paths[paths.length - 1];
          if (path && fileSetRef.current.has(path)) {
            onOpenRef.current?.(path);
          }
        },
      }),
      [],
    ),
  );

  // Rebuild paths only when the fetched tree changes. resetPaths is a coarse
  // whole-tree reset that collapses expansion, so it must not run on a status
  // change.
  useEffect(() => {
    if (result?.status !== "ready") return;
    fileSetRef.current = new Set(result.paths);
    model.resetPaths(result.paths, {
      preparedInput: prepareFileTreeInput(result.paths),
    });
  }, [result, model]);

  // Apply git-status colors independently (keyed by path, order-independent)
  // so live diff updates recolor files without collapsing expanded folders.
  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  // Reveal + highlight the file open in the preview.
  useEffect(() => {
    if (result?.status !== "ready" || !activeRepoFilePath) return;
    if (!fileSetRef.current.has(activeRepoFilePath)) return;
    model.scrollToPath(activeRepoFilePath, { focus: true });
  }, [activeRepoFilePath, result, model]);

  if (!threadId) {
    return (
      <ArtifactWorkspaceState
        variant="error"
        title="Tree unavailable"
        description="A thread is required to browse repo files."
      />
    );
  }

  if (query.isLoading) {
    return (
      <ArtifactWorkspaceState
        variant="loading"
        title="Loading files"
        description="Fetching the repository file tree."
      />
    );
  }

  if (query.isError || !result) {
    return (
      <ArtifactWorkspaceState
        variant="error"
        title="Tree unavailable"
        description="Failed to load the file tree from the repository."
      />
    );
  }

  if (result.status === "error") {
    return (
      <ArtifactWorkspaceState
        variant="error"
        title="Tree unavailable"
        description={describeRepoTreeError(result.category)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {result.truncated && (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          This repository is large, so the tree is partial — some files are not
          listed.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <FileTree model={model} className="h-full" />
      </div>
    </div>
  );
}

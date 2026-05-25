import type { DBMessage } from "@terragon/shared";
import { ThreadInfoFull, type UIGitDiffPart } from "@terragon/shared";
import type { FileChangeType, ParsedDiffFile } from "@/lib/git-diff";

/**
 * Drives the git-diff focus effect off a monotonic `nonce` rather than the bare
 * path. Re-focusing the same file (e.g. clicking file A again after scrolling
 * away) keeps `path` identical but bumps `nonce`, so the focus effect still
 * re-runs instead of short-circuiting on an unchanged string.
 */
export interface RepoFileFocus {
  path: string;
  nonce: number;
}

export interface GitDiffViewProps {
  thread: ThreadInfoFull;
  mode?: "split" | "unified";
  enableComments?: boolean;
  diffPart?: UIGitDiffPart;
  threadChatId?: string;
  threadMessages?: DBMessage[];
  // s3 open-repo-file flow. When provided and the `repoFilePreview` flag is on,
  // clicking a file path in the tree opens it in the artifacts panel instead of
  // scrolling to the inline diff.
  onOpenRepoFile?: (path: string, preferArtifactId?: string) => void;
  /**
   * When set, the view scrolls to (and expands) the diff for this
   * repo-relative path when the `nonce` changes. Used by the repo-file preview
   * flow so clicking a file path lands on that file's diff in the panel.
   */
  focusFile?: RepoFileFocus | null;
}

export interface FileTreeNode {
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

export interface FileDiffWrapperProps {
  parsedFile: ParsedDiffFile;
  mode: "split" | "unified";
  expanded: boolean;
  onToggle: () => void;
  thread: ThreadInfoFull;
  enableComments: boolean;
  threadChatId?: string;
  threadMessages?: DBMessage[];
  forceUnified?: boolean;
  // When provided, renders an "open file" affordance in the diff header that
  // routes the file's repo-relative path to the open-repo-file flow. Absent =>
  // header only toggles expand/collapse (unchanged behavior).
  onOpenRepoFile?: (path: string, preferArtifactId?: string) => void;
}

export interface CommentWidgetData {
  isAddition: boolean;
}

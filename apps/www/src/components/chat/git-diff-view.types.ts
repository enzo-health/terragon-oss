import type { DBMessage } from "@terragon/shared";
import { ThreadInfoFull, type UIGitDiffPart } from "@terragon/shared";
import type { FileChangeType, ParsedDiffFile } from "@/lib/git-diff";

export interface GitDiffViewProps {
  thread: ThreadInfoFull;
  mode?: "split" | "unified";
  enableComments?: boolean;
  diffPart?: UIGitDiffPart;
  threadChatId?: string;
  threadMessages?: DBMessage[];
  // s3 open-repo-file flow. When provided (flag-gated at the producer), clicking
  // a file path in the tree opens it in the artifacts panel instead of scrolling
  // to the inline diff.
  onOpenRepoFile?: (path: string) => void;
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
  onOpenRepoFile?: (path: string) => void;
}

export interface CommentWidgetData {
  isAddition: boolean;
}

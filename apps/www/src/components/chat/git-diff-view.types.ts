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
}

export interface CommentWidgetData {
  isAddition: boolean;
}

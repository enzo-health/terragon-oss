import React from "react";
import { AllToolParts, type DBDiffPart } from "@terragon/shared";
import { FileDiff, FilePlus, FileX } from "lucide-react";
import { DiffPartView } from "../diff-part";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentRow,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithText,
} from "./generic-ui";
import {
  FILE_CHANGE_DIFF_RESULT_TYPE,
  type FileChangeDiffToolResult,
} from "./tool-registry";

function getFileIcon(action?: string) {
  switch (action) {
    case "created":
      return <FilePlus className="size-3.5 text-success shrink-0" />;
    case "deleted":
      return <FileX className="size-3.5 text-error shrink-0" />;
    default:
      return <FileDiff className="size-3.5 text-warning shrink-0" />;
  }
}

function basename(filePath: string) {
  return filePath.split("/").pop() ?? filePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDiffStatus(value: unknown): value is DBDiffPart["status"] {
  return value === "pending" || value === "applied" || value === "rejected";
}

function isFileChangeDiffToolResult(
  value: unknown,
): value is FileChangeDiffToolResult {
  if (!isRecord(value) || value.type !== FILE_CHANGE_DIFF_RESULT_TYPE) {
    return false;
  }
  const part = value.part;
  return (
    isRecord(part) &&
    part.type === "diff" &&
    typeof part.filePath === "string" &&
    typeof part.newContent === "string" &&
    (part.oldContent === undefined || typeof part.oldContent === "string") &&
    (part.unifiedDiff === undefined || typeof part.unifiedDiff === "string") &&
    isDiffStatus(part.status)
  );
}

export function diffPartFromFileChangeResult(
  result: string,
): DBDiffPart | null {
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isFileChangeDiffToolResult(parsed)) return null;
    const part = parsed.part;
    return {
      type: "diff",
      filePath: part.filePath,
      ...(part.oldContent !== undefined ? { oldContent: part.oldContent } : {}),
      newContent: part.newContent,
      ...(part.unifiedDiff !== undefined
        ? { unifiedDiff: part.unifiedDiff }
        : {}),
      status: part.status,
    };
  } catch {
    return null;
  }
}

export function FileChangeTool({
  toolPart,
  onOpenRepoFile,
}: {
  toolPart: Extract<AllToolParts, { name: "FileChange" }>;
  onOpenRepoFile?: (filePath: string) => void;
}) {
  const files = toolPart.parameters?.files ?? [];
  const toolArg =
    files.length === 1 ? basename(files[0]!.path) : `${files.length} files`;
  const singleFilePath = files.length === 1 ? files[0]!.path : null;

  return (
    <GenericToolPart
      toolName="FileChange"
      toolArg={toolArg}
      toolStatus={toolPart.status}
      onToolArgClick={
        onOpenRepoFile && singleFilePath
          ? () => onOpenRepoFile(singleFilePath)
          : undefined
      }
    >
      <FileChangeToolContent
        toolPart={toolPart}
        onOpenRepoFile={onOpenRepoFile}
      />
    </GenericToolPart>
  );
}

function FileChangeToolContent({
  toolPart,
  onOpenRepoFile,
}: {
  toolPart: Extract<AllToolParts, { name: "FileChange" }>;
  onOpenRepoFile?: (filePath: string) => void;
}) {
  if (toolPart.status === "pending") {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        Applying changes...
      </GenericToolPartContentOneLine>
    );
  }
  if (toolPart.status === "error") {
    return (
      <GenericToolPartContentResultWithText
        content={toolPart.result}
        toolStatus="error"
      />
    );
  }
  const diffPart = diffPartFromFileChangeResult(toolPart.result);
  if (diffPart) {
    return (
      <GenericToolPartContent toolStatus={toolPart.status}>
        <GenericToolPartContentRow index={0} className="pr-2">
          <DiffPartView part={diffPart} onOpenRepoFile={onOpenRepoFile} />
        </GenericToolPartContentRow>
      </GenericToolPartContent>
    );
  }
  const files = toolPart.parameters?.files ?? [];
  return (
    <GenericToolPartContent toolStatus={toolPart.status}>
      {files.map((file, i) => (
        <GenericToolPartContentRow key={file.path} index={i}>
          {onOpenRepoFile ? (
            <button
              type="button"
              onClick={() => onOpenRepoFile(file.path)}
              title={file.path}
              data-testid="file-change-open-file"
              className="flex items-center gap-1.5 bg-transparent border-0 p-0 cursor-pointer text-left"
            >
              {getFileIcon(file.action)}
              <span className="font-mono truncate underline decoration-dotted underline-offset-2 hover:decoration-solid">
                {basename(file.path)}
              </span>
            </button>
          ) : (
            <span className="flex items-center gap-1.5" title={file.path}>
              {getFileIcon(file.action)}
              <span className="font-mono truncate">{basename(file.path)}</span>
            </span>
          )}
        </GenericToolPartContentRow>
      ))}
    </GenericToolPartContent>
  );
}

import React from "react";
import { AllToolParts, type DBDiffPart } from "@terragon/shared";
import { FileDiff, FilePlus, FileX } from "lucide-react";
import { DiffPartView } from "../diff-part";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentRow,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithLines,
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
}: {
  toolPart: Extract<AllToolParts, { name: "FileChange" }>;
}) {
  const files = toolPart.parameters?.files ?? [];
  const toolArg =
    files.length === 1 ? basename(files[0]!.path) : `${files.length} files`;

  return (
    <GenericToolPart
      toolName="FileChange"
      toolArg={toolArg}
      toolStatus={toolPart.status}
    >
      <FileChangeToolContent toolPart={toolPart} />
    </GenericToolPart>
  );
}

function FileChangeToolContent({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "FileChange" }>;
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
      <GenericToolPartContentResultWithLines
        lines={toolPart.result.split("\n")}
        toolStatus="error"
      />
    );
  }
  const diffPart = diffPartFromFileChangeResult(toolPart.result);
  if (diffPart) {
    return (
      <GenericToolPartContent toolStatus={toolPart.status}>
        <GenericToolPartContentRow index={0} className="pr-2">
          <DiffPartView part={diffPart} />
        </GenericToolPartContentRow>
      </GenericToolPartContent>
    );
  }
  const files = toolPart.parameters?.files ?? [];
  return (
    <GenericToolPartContent toolStatus={toolPart.status}>
      {files.map((file, i) => (
        <GenericToolPartContentRow key={file.path} index={i}>
          <span className="flex items-center gap-1.5" title={file.path}>
            {getFileIcon(file.action)}
            <span className="font-mono truncate">{basename(file.path)}</span>
          </span>
        </GenericToolPartContentRow>
      ))}
    </GenericToolPartContent>
  );
}

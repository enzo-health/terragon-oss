import React from "react";
import { AllToolParts } from "@terragon/shared";
import { FileDiff, FilePlus, FileX } from "lucide-react";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentRow,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithLines,
} from "./generic-ui";

function getFileIcon(action?: string) {
  switch (action) {
    case "created":
      return <FilePlus className="size-3.5 text-green-500 shrink-0" />;
    case "deleted":
      return <FileX className="size-3.5 text-red-500 shrink-0" />;
    default:
      return <FileDiff className="size-3.5 text-yellow-500 shrink-0" />;
  }
}

function basename(filePath: string) {
  return filePath.split("/").pop() ?? filePath;
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

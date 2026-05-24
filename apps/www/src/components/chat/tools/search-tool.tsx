import React, { useMemo } from "react";
import { AllToolParts } from "@terragon/shared";
import {
  GenericToolPart,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithText,
  GenericToolPartContentResultWithPreview,
} from "./generic-ui";
import { countTextLines, formatToolParameters, splitFirstLine } from "./utils";

export function SearchTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Grep" | "Glob" }>;
}) {
  const toolArg = useMemo(
    () =>
      formatToolParameters(toolPart.parameters, {
        keyOrder: ["pattern", "path", "include"],
      }),
    [toolPart.parameters],
  );

  return (
    <GenericToolPart
      toolName="Search"
      toolArg={toolArg}
      toolStatus={toolPart.status}
    >
      {toolPart.name === "Grep" ? (
        <ToolPartGrepContent toolPart={toolPart} />
      ) : (
        <ToolPartGlobContent toolPart={toolPart} />
      )}
    </GenericToolPart>
  );
}

function ToolPartGrepContent({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Grep" }>;
}) {
  if (toolPart.status === "pending") {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        Searching...
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
  if (toolPart.result.length === 0) {
    return null;
  }
  // Try to match Found X files
  const { firstLine, rest } = splitFirstLine(toolPart.result);
  const foundFiles = firstLine.match(/Found (\d+) files/);
  if (foundFiles) {
    return (
      <GenericToolPartContentResultWithPreview
        toolStatus={toolPart.status}
        showAllLabel="Show file list"
        showLessLabel="Hide file list"
        preview={
          <>
            Found <span className="font-semibold">{foundFiles[1]}</span> files
          </>
        }
        content={rest}
      />
    );
  }
  return (
    <GenericToolPartContentResultWithText
      content={toolPart.result}
      toolStatus={toolPart.status}
    />
  );
}

function ToolPartGlobContent({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Glob" }>;
}) {
  if (toolPart.status === "pending") {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        Searching...
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
  if (toolPart.result.length === 0) {
    return null;
  }
  const numFiles = countTextLines(toolPart.result);
  return (
    <GenericToolPartContentResultWithPreview
      toolStatus={toolPart.status}
      showAllLabel="Show file list"
      showLessLabel="Hide file list"
      preview={
        <>
          Found <span className="font-semibold">{numFiles}</span> files
        </>
      }
      content={toolPart.result}
    />
  );
}

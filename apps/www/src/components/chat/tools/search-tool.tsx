import React from "react";
import { AllToolParts } from "@leo/shared";
import {
  GenericToolPart,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithLines,
  GenericToolPartContentResultWithPreview,
} from "./generic-ui";
import { formatToolParameters } from "./utils";

export function SearchTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Grep" | "Glob" }>;
}) {
  return (
    <GenericToolPart
      toolName="Search"
      toolArg={formatToolParameters(toolPart.parameters, {
        keyOrder: ["pattern", "path", "include"],
      })}
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
      <GenericToolPartContentResultWithLines
        lines={toolPart.result.split("\n")}
        toolStatus="error"
      />
    );
  }
  const lines = toolPart.result.split("\n");
  if (lines.length === 0) {
    return null;
  }
  // Try to match Found X files
  const firstLine = lines[0]!;
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
        content={lines.slice(1).join("\n")}
      />
    );
  }
  return (
    <GenericToolPartContentResultWithLines
      lines={lines}
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
      <GenericToolPartContentResultWithLines
        lines={toolPart.result.split("\n")}
        toolStatus="error"
      />
    );
  }
  const lines = toolPart.result.split("\n");
  if (lines.length === 0) {
    return null;
  }
  const numFiles = lines.length;
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

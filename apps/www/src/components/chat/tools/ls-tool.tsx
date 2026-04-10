import React from "react";
import { AllToolParts } from "@leo/shared";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithLines,
  GenericToolPartContentRow,
} from "./generic-ui";
import { formatToolParameters } from "./utils";

export function LSTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "LS" }>;
}) {
  return (
    <GenericToolPart
      toolName="List"
      toolArg={formatToolParameters(toolPart.parameters, {
        keyOrder: ["path", "ignore"],
      })}
      toolStatus={toolPart.status}
    >
      <LsToolContent toolPart={toolPart} />
    </GenericToolPart>
  );
}

function LsToolContent({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "LS" }>;
}) {
  if (toolPart.status === "pending") {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        Listing Files...
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
  const numFiles = lines.filter((line) => line.trim().startsWith("-")).length;
  return (
    <GenericToolPartContent
      toolStatus={toolPart.status}
      className="max-h-[150px] overflow-y-auto"
    >
      <GenericToolPartContentRow index={0}>
        <span>
          Listed <span className="font-semibold">{numFiles}</span> paths
        </span>
      </GenericToolPartContentRow>
    </GenericToolPartContent>
  );
}

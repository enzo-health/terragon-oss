import React from "react";
import { AllToolParts } from "@leo/shared";
import {
  GenericToolPart,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithLines,
  GenericToolPartContentResultWithPreview,
} from "./generic-ui";

export function NotebookEditTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "NotebookEdit" }>;
}) {
  return (
    <GenericToolPart
      toolName="NotebookEdit"
      toolArg={toolPart.parameters.notebook_path}
      toolStatus={toolPart.status}
    >
      {toolPart.status === "pending" ? (
        <GenericToolPartContentOneLine toolStatus="pending">
          Editing...
        </GenericToolPartContentOneLine>
      ) : toolPart.status === "error" ? (
        <GenericToolPartContentResultWithLines
          lines={toolPart.result.split("\n")}
          toolStatus="error"
        />
      ) : (
        <GenericToolPartContentResultWithPreview
          preview="Done"
          content={toolPart.result}
          toolStatus="completed"
        />
      )}
    </GenericToolPart>
  );
}

export function NotebookReadTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "NotebookRead" }>;
}) {
  return (
    <GenericToolPart
      toolName="NotebookRead"
      toolArg={toolPart.parameters.notebook_path}
      toolStatus={toolPart.status}
    >
      {toolPart.status === "pending" ? (
        <GenericToolPartContentOneLine toolStatus="pending">
          Reading...
        </GenericToolPartContentOneLine>
      ) : toolPart.status === "error" ? (
        <GenericToolPartContentResultWithLines
          lines={toolPart.result.split("\n")}
          toolStatus="error"
        />
      ) : (
        <GenericToolPartContentResultWithPreview
          preview="Done"
          content={toolPart.result}
          toolStatus="completed"
        />
      )}
    </GenericToolPart>
  );
}

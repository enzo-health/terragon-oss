import React from "react";
import { AllToolParts } from "@terragon/shared";
import {
  GenericToolPart,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithText,
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
        <GenericToolPartContentResultWithText
          content={toolPart.result}
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
        <GenericToolPartContentResultWithText
          content={toolPart.result}
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

import React, { useState } from "react";
import { AllToolParts } from "@terragon/shared";
import { MultiEditDiffView } from "@/components/shared/diff-view";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentRow,
  GenericToolPartClickToExpand,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithLines,
} from "./generic-ui";
import { formatToolParameters } from "./utils";

export function MultiEditTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "MultiEdit" }>;
}) {
  return (
    <GenericToolPart
      toolName="MultiEdit"
      toolArg={formatToolParameters(
        {
          file_path: toolPart.parameters.file_path,
          edits: toolPart.parameters.edits.length,
        },
        {
          keyOrder: ["file_path", "edits"],
        },
      )}
      toolStatus={toolPart.status}
    >
      <ToolPartMultiEditResult toolPart={toolPart} />
    </GenericToolPart>
  );
}

function ToolPartMultiEditResult({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "MultiEdit" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (toolPart.status === "pending") {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        Editing...
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
  return (
    <GenericToolPartContent toolStatus={toolPart.status}>
      <GenericToolPartContentRow index={0}>
        <span>
          Applied{" "}
          <span className="font-semibold">
            {toolPart.parameters.edits.length}
          </span>{" "}
          edits{" "}
          <GenericToolPartClickToExpand
            label={expanded ? "Hide edits" : "Show edits"}
            onClick={() => setExpanded((x) => !x)}
            isExpanded={expanded}
          />
        </span>
      </GenericToolPartContentRow>
      {expanded && (
        <GenericToolPartContentRow index={1} className="pr-2">
          <MultiEditDiffView
            defaultExpanded={true}
            chunkClassName="max-h-[350px]"
            filePath={toolPart.parameters.file_path}
            edits={toolPart.parameters.edits}
          />
        </GenericToolPartContentRow>
      )}
    </GenericToolPartContent>
  );
}

import React, { useState } from "react";
import { AllToolParts } from "@terragon/shared";
import { WriteDiffView } from "@/components/shared/diff-view";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentRow,
  GenericToolPartClickToExpand,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithLines,
} from "./generic-ui";
import { formatToolParameters } from "./utils";

export function WriteTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Write" }>;
}) {
  return (
    <GenericToolPart
      toolName="Write"
      toolArg={formatToolParameters(toolPart.parameters, {
        keyOrder: ["file_path"],
        excludeKeys: ["content"],
      })}
      toolStatus={toolPart.status}
    >
      <WriteToolContent toolPart={toolPart} />
    </GenericToolPart>
  );
}

function WriteToolContent({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Write" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (toolPart.status === "pending") {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        Writing...
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
          Wrote{" "}
          <span className="font-semibold">
            {toolPart.parameters.content.split("\n").length}
          </span>{" "}
          lines{" "}
          <GenericToolPartClickToExpand
            label={expanded ? "Hide lines" : "Show lines"}
            onClick={() => setExpanded((x) => !x)}
            isExpanded={expanded}
          />
        </span>
      </GenericToolPartContentRow>
      {expanded && (
        <GenericToolPartContentRow index={1} className="pr-2">
          <WriteDiffView
            defaultExpanded={true}
            chunkClassName="max-h-[350px]"
            filePath={toolPart.parameters.file_path}
            newStr={toolPart.parameters.content}
          />
        </GenericToolPartContentRow>
      )}
    </GenericToolPartContent>
  );
}

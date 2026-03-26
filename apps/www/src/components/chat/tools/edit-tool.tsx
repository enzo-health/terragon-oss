import React, { useState } from "react";
import { AllToolParts } from "@terragon/shared";
import { EditDiffView } from "@/components/shared/diff-view";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentRow,
  GenericToolPartClickToExpand,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithLines,
} from "./generic-ui";
import { formatToolParameters } from "./utils";

export function EditTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Edit" }>;
}) {
  return (
    <GenericToolPart
      toolName="Update"
      toolArg={formatToolParameters(toolPart.parameters, {
        keyOrder: ["file_path"],
        excludeKeys: ["old_string", "new_string", "expected_replacements"],
      })}
      toolStatus={toolPart.status}
    >
      <ToolPartEditResult toolPart={toolPart} />
    </GenericToolPart>
  );
}

function ToolPartEditResult({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Edit" }>;
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
        toolStatus="error"
        lines={toolPart.result?.split("\n") ?? []}
      />
    );
  }
  return (
    <GenericToolPartContent toolStatus={toolPart.status}>
      <GenericToolPartContentRow index={0}>
        <span>
          <span className="font-semibold">
            <span className="text-green-700">
              +{toolPart.parameters.new_string.split("\n").length}
            </span>{" "}
            <span className="text-red-700">
              -{toolPart.parameters.old_string.split("\n").length}
            </span>
          </span>{" "}
          <GenericToolPartClickToExpand
            label={expanded ? "Hide diff" : "Show diff"}
            onClick={() => setExpanded((x) => !x)}
            isExpanded={expanded}
          />
        </span>
      </GenericToolPartContentRow>
      {expanded && (
        <GenericToolPartContentRow index={1} className="pr-2">
          <EditDiffView
            defaultExpanded={true}
            chunkClassName="max-h-[350px]"
            filePath={toolPart.parameters.file_path}
            oldStr={toolPart.parameters.old_string}
            newStr={toolPart.parameters.new_string}
          />
        </GenericToolPartContentRow>
      )}
    </GenericToolPartContent>
  );
}

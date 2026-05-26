import React, { useMemo, useState } from "react";
import { AllToolParts } from "@terragon/shared";
import { EditDiffView } from "@/components/shared/diff-view";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentRow,
  GenericToolPartClickToExpand,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithText,
} from "./generic-ui";
import { countTextLines, formatToolParameters } from "./utils";

export function EditTool({
  toolPart,
  onToolArgClick,
}: {
  toolPart: Extract<AllToolParts, { name: "Edit" }>;
  onToolArgClick?: () => void;
}) {
  return (
    <GenericToolPart
      toolName="Update"
      toolArg={formatToolParameters(toolPart.parameters, {
        keyOrder: ["file_path"],
        excludeKeys: ["old_string", "new_string", "expected_replacements"],
      })}
      toolStatus={toolPart.status}
      onToolArgClick={onToolArgClick}
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
  const newLineCount = useMemo(
    () => countTextLines(toolPart.parameters.new_string),
    [toolPart.parameters.new_string],
  );
  const oldLineCount = useMemo(
    () => countTextLines(toolPart.parameters.old_string),
    [toolPart.parameters.old_string],
  );
  if (toolPart.status === "pending") {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        Editing...
      </GenericToolPartContentOneLine>
    );
  }
  if (toolPart.status === "error") {
    return (
      <GenericToolPartContentResultWithText
        toolStatus="error"
        content={toolPart.result ?? ""}
      />
    );
  }
  return (
    <GenericToolPartContent toolStatus={toolPart.status}>
      <GenericToolPartContentRow index={0}>
        <span>
          <span className="font-semibold">
            <span className="text-success">+{newLineCount}</span>{" "}
            <span className="text-error">-{oldLineCount}</span>
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

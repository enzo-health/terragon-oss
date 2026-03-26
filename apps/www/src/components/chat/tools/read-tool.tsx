import React, { useState } from "react";
import { AllToolParts } from "@terragon/shared";
import { NoChangesDiffView } from "@/components/shared/diff-view";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentRow,
  GenericToolPartClickToExpand,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithLines,
} from "./generic-ui";
import { formatToolParameters } from "./utils";

export function ReadTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Read" }>;
}) {
  return (
    <GenericToolPart
      toolName="Read"
      toolArg={formatToolParameters(toolPart.parameters, {
        keyOrder: ["file_path", "offset", "limit"],
      })}
      toolStatus={toolPart.status}
    >
      <ReadToolContent toolPart={toolPart} />
    </GenericToolPart>
  );
}

function stripSystemReminder(content: string): string {
  // Remove system-reminder suffix if present
  const systemReminderPattern =
    /\n<system-reminder>[\s\S]*?<\/system-reminder>\s*$/;
  return content.replace(systemReminderPattern, "");
}

export function formatReadResult(result: string) {
  // First strip any system-reminder suffix
  const strippedResult = stripSystemReminder(result);

  // If every line looks like lineNo\tlineContent (cat -n format) or lineNo→\tlineContent, then remove the lineNo prefix
  const lines = strippedResult.split("\n");
  let allMatch = true;
  const formattedLines = lines.map((line) => {
    // Match: optional spaces, digits + tab, digits + arrow + optional tab
    // then capture everything after the tab
    const match = line.match(/^\s*(?:(?:\d+\t)|(?:\d+→\t?))(.*)$/);
    if (match) {
      return match[1];
    }
    allMatch = false;
    return line;
  });
  if (allMatch) {
    return formattedLines.join("\n");
  }
  return strippedResult;
}

function ReadToolContent({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Read" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (toolPart.status === "pending") {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        Reading...
      </GenericToolPartContentOneLine>
    );
  }
  if (toolPart.status === "error") {
    return (
      <GenericToolPartContentResultWithLines
        lines={stripSystemReminder(toolPart.result).split("\n")}
        toolStatus="error"
      />
    );
  }
  const formattedResult = formatReadResult(toolPart.result);
  return (
    <GenericToolPartContent toolStatus={toolPart.status}>
      <GenericToolPartContentRow index={0}>
        <span>
          Read{" "}
          <span className="font-semibold">
            {formattedResult.split("\n").length}
          </span>{" "}
          lines
        </span>{" "}
        <GenericToolPartClickToExpand
          label={expanded ? "Hide lines" : "Show lines"}
          onClick={() => setExpanded((x) => !x)}
          isExpanded={expanded}
        />
      </GenericToolPartContentRow>
      {expanded && (
        <GenericToolPartContentRow index={1} className="pr-2">
          <NoChangesDiffView
            defaultExpanded={true}
            chunkClassName="max-h-[350px]"
            filePath={toolPart.parameters.file_path}
            contents={formattedResult}
          />
        </GenericToolPartContentRow>
      )}
    </GenericToolPartContent>
  );
}

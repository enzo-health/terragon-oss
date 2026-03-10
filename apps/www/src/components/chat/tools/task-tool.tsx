import React, { useState } from "react";
import { AllToolParts } from "@terragon/shared";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentRow,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithLines,
  GenericToolPartClickToExpand,
} from "./generic-ui";

function countToolParts(parts: AllToolParts["parts"]) {
  let total = 0;
  let completed = 0;
  for (const part of parts) {
    if (part.type === "tool") {
      total++;
      if (part.status === "completed" || part.status === "error") {
        completed++;
      }
    }
  }
  return { total, completed };
}

export function TaskTool({
  toolPart,
  renderToolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Task" }>;
  renderToolPart: (toolPart: AllToolParts) => React.ReactNode;
}) {
  // Display the subagent_type if available, otherwise default to "Task"
  // If subagent_type is "general-purpose", also show "Task"
  const toolName =
    toolPart.parameters.subagent_type &&
    toolPart.parameters.subagent_type !== "general-purpose"
      ? toolPart.parameters.subagent_type
      : "Task";

  // Extract agent color from parameters if available
  const toolColor = (toolPart.parameters as any)._agent_color;

  const { total, completed } = countToolParts(toolPart.parts);
  const toolCountSuffix =
    total > 0 ? (
      <span className="text-muted-foreground text-xs font-mono ml-1">
        {completed}/{total} tools
      </span>
    ) : null;

  return (
    <GenericToolPart
      toolName={toolName}
      toolArg={toolPart.parameters.description}
      toolStatus={toolPart.status}
      toolColor={toolColor}
      toolArgSuffix={toolCountSuffix}
    >
      <TaskToolContent toolPart={toolPart} renderToolPart={renderToolPart} />
    </GenericToolPart>
  );
}

function getTaskToolResultOrNull(
  toolPart: Extract<AllToolParts, { name: "Task" }>,
) {
  try {
    if ("result" in toolPart) {
      try {
        const result = JSON.parse(toolPart.result);
        return result[0]?.text ?? null;
      } catch (error) {
        return toolPart.result;
      }
    }
  } catch (error) {}
  return null;
}

function TaskToolContent({
  toolPart,
  renderToolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Task" }>;
  renderToolPart: (toolPart: AllToolParts) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  if (toolPart.status === "pending" && toolPart.parts.length === 0) {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        Working...
      </GenericToolPartContentOneLine>
    );
  }

  // Count how many tool parts we have
  const toolResult = getTaskToolResultOrNull(toolPart);
  const maxToolsToShow = expanded ? Infinity : toolResult ? 0 : 1;
  const toolParts = toolPart.parts;

  let numTools = 0;
  const toolIndicesToShow = new Set<number>();
  for (let i = toolParts.length - 1; i >= 0; i--) {
    if (toolParts[i]?.type === "tool") {
      numTools++;
      if (toolIndicesToShow.size < maxToolsToShow) {
        toolIndicesToShow.add(i);
      }
    }
  }
  if (numTools === 1) {
    toolIndicesToShow.add(0);
  }
  const numToolsToHide = numTools - toolIndicesToShow.size;
  const indexOffset = numToolsToHide > 0 || expanded ? 1 : 0;
  return (
    <GenericToolPartContent
      toolStatus={toolPart.status}
      className="text-foreground"
    >
      <div className="col-span-full border-l-2 border-border pl-2">
        {numToolsToHide > 0 && !expanded && (
          <GenericToolPartContentRow index={0}>
            <div className="text-sm text-muted-foreground italic">
              {numToolsToHide === 1
                ? numTools === 1
                  ? "1 tool "
                  : "1 other tool..."
                : numToolsToHide === numTools
                  ? `${numToolsToHide} tools...`
                  : `${numToolsToHide} other tools...`}
              <GenericToolPartClickToExpand
                label="Show all tools"
                onClick={() => setExpanded(true)}
              />
            </div>
          </GenericToolPartContentRow>
        )}
        {expanded && numTools > 1 && (
          <GenericToolPartContentRow index={0}>
            <div className="text-sm text-muted-foreground italic">
              Showing all {numTools} tools{" "}
              <GenericToolPartClickToExpand
                label="Show less"
                onClick={() => setExpanded(false)}
              />
            </div>
          </GenericToolPartContentRow>
        )}
        {toolPart.parts.map((part, index) => {
          if (part.type === "tool" && toolIndicesToShow.has(index)) {
            return (
              <GenericToolPartContentRow
                key={index}
                index={index + indexOffset}
              >
                {renderToolPart(part)}
              </GenericToolPartContentRow>
            );
          }
          if (part.type === "text") {
            return (
              <GenericToolPartContentRow
                key={index}
                index={index + indexOffset}
              >
                <GenericToolPartContentResultWithLines
                  lines={part.text.split("\n")}
                  toolStatus={toolPart.status}
                  singleColumn={true}
                />
              </GenericToolPartContentRow>
            );
          }
        })}
        {toolResult && (
          <GenericToolPartContentRow index={-1}>
            <GenericToolPartContentResultWithLines
              lines={toolResult.split("\n")}
              toolStatus={toolPart.status}
              singleColumn={true}
            />
          </GenericToolPartContentRow>
        )}
      </div>
    </GenericToolPartContent>
  );
}

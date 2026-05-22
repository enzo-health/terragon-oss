import React, { useMemo, useState } from "react";
import { AllToolParts } from "@terragon/shared";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentRow,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithText,
  GenericToolPartClickToExpand,
} from "./generic-ui";
import { getToolVerb } from "./utils";

function getAgentColor(
  parameters: Record<string, unknown>,
): string | undefined {
  const color = parameters._agent_color;
  return typeof color === "string" ? color : undefined;
}

type TaskVisibleRow = {
  part: AllToolParts["parts"][number];
  index: number;
};

type TaskToolSummary = {
  totalTools: number;
  completedTools: number;
  visibleRows: TaskVisibleRow[];
};

function summarizeTaskToolParts({
  toolParts,
  expanded,
  maxToolsToShow,
}: {
  toolParts: AllToolParts["parts"];
  expanded: boolean;
  maxToolsToShow: number;
}): TaskToolSummary {
  let totalTools = 0;
  let completedTools = 0;
  const toolIndices: number[] = [];

  for (let index = 0; index < toolParts.length; index += 1) {
    const part = toolParts[index];
    if (part?.type !== "tool") continue;
    totalTools += 1;
    toolIndices.push(index);
    if (part.status === "completed" || part.status === "error") {
      completedTools += 1;
    }
  }

  const visibleToolIndices = new Set<number>();
  if (expanded) {
    for (const index of toolIndices) {
      visibleToolIndices.add(index);
    }
  } else {
    for (
      let index = toolIndices.length - 1;
      index >= 0 && visibleToolIndices.size < maxToolsToShow;
      index -= 1
    ) {
      visibleToolIndices.add(toolIndices[index]!);
    }
    if (totalTools === 1) {
      visibleToolIndices.add(toolIndices[0]!);
    }
  }

  const visibleRows: TaskVisibleRow[] = [];
  for (let index = 0; index < toolParts.length; index += 1) {
    const part = toolParts[index];
    if (!part) continue;
    if (part.type === "tool") {
      if (visibleToolIndices.has(index)) {
        visibleRows.push({ part, index });
      }
      continue;
    }
    if (part.type === "text" && (expanded || totalTools === 0)) {
      visibleRows.push({ part, index });
    }
  }

  return { totalTools, completedTools, visibleRows };
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

  const toolColor = getAgentColor(toolPart.parameters);
  const [expanded, setExpanded] = useState(false);
  const toolResult = useMemo(
    () => getTaskToolResultOrNull(toolPart),
    [toolPart],
  );
  const maxToolsToShow = expanded ? Infinity : toolResult ? 0 : 1;

  const summary = useMemo(
    () =>
      summarizeTaskToolParts({
        toolParts: toolPart.parts,
        expanded,
        maxToolsToShow,
      }),
    [expanded, maxToolsToShow, toolPart.parts],
  );
  const toolCountSuffix =
    summary.totalTools > 0 ? (
      <span className="text-muted-foreground text-xs font-mono ml-1">
        {summary.completedTools}/{summary.totalTools} tools
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
      <TaskToolContent
        toolPart={toolPart}
        renderToolPart={renderToolPart}
        expanded={expanded}
        setExpanded={setExpanded}
        toolResult={toolResult}
        summary={summary}
      />
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
  expanded,
  setExpanded,
  toolResult,
  summary,
}: {
  toolPart: Extract<AllToolParts, { name: "Task" }>;
  renderToolPart: (toolPart: AllToolParts) => React.ReactNode;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  toolResult: string | null;
  summary: TaskToolSummary;
}) {
  if (toolPart.status === "pending" && toolPart.parts.length === 0) {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        {getToolVerb("Task", "pending")}
      </GenericToolPartContentOneLine>
    );
  }
  const visibleToolCount = summary.visibleRows.reduce(
    (count, row) => count + (row.part.type === "tool" ? 1 : 0),
    0,
  );
  const numToolsToHide = summary.totalTools - visibleToolCount;
  const indexOffset = numToolsToHide > 0 || expanded ? 1 : 0;
  return (
    <GenericToolPartContent
      toolStatus={toolPart.status}
      className="text-foreground"
    >
      <div className="col-span-full pl-3">
        {numToolsToHide > 0 && !expanded && (
          <GenericToolPartContentRow index={0}>
            <div className="text-sm text-muted-foreground italic">
              {numToolsToHide === 1
                ? summary.totalTools === 1
                  ? "1 tool "
                  : "1 other tool..."
                : numToolsToHide === summary.totalTools
                  ? `${numToolsToHide} tools...`
                  : `${numToolsToHide} other tools...`}
              <GenericToolPartClickToExpand
                label="Show all tools"
                onClick={() => setExpanded(true)}
                isExpanded={false}
              />
            </div>
          </GenericToolPartContentRow>
        )}
        {expanded && summary.totalTools > 1 && (
          <GenericToolPartContentRow index={0}>
            <div className="text-sm text-muted-foreground italic">
              Showing all {summary.totalTools} tools{" "}
              <GenericToolPartClickToExpand
                label="Show less"
                onClick={() => setExpanded(false)}
                isExpanded={true}
              />
            </div>
          </GenericToolPartContentRow>
        )}
        {summary.visibleRows.map(({ part, index }) => {
          if (part.type === "tool") {
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
                <GenericToolPartContentResultWithText
                  content={part.text}
                  toolStatus={toolPart.status}
                  singleColumn={true}
                />
              </GenericToolPartContentRow>
            );
          }
        })}
        {toolResult && (
          <GenericToolPartContentRow index={-1}>
            <GenericToolPartContentResultWithText
              content={toolResult}
              toolStatus={toolPart.status}
              singleColumn={true}
            />
          </GenericToolPartContentRow>
        )}
      </div>
    </GenericToolPartContent>
  );
}

import React, { useMemo, useState } from "react";
import { AllToolParts } from "@terragon/shared";
import { Copy, Check } from "lucide-react";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentRow,
  GenericToolPartContentOneLine,
  GenericToolPartClickToExpand,
  AnsiText,
} from "./generic-ui";
import { createTextLinePreview } from "./utils";

function parseExitCode(result: string): number | null {
  const match = result.match(/\[exit code: (\d+)\]/);
  return match ? parseInt(match[1]!, 10) : null;
}

export function BashTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "Bash" }>;
}) {
  const exitCode =
    toolPart.status !== "pending" ? parseExitCode(toolPart.result) : null;

  return (
    <GenericToolPart
      toolName="Bash"
      toolArg={toolPart.parameters.command}
      toolStatus={toolPart.status}
      toolArgSuffix={
        exitCode !== null && exitCode !== 0 ? (
          <span className="text-error text-xs font-mono ml-1">
            Exit code: {exitCode}
          </span>
        ) : null
      }
    >
      {toolPart.status === "pending" ? (
        <GenericToolPartContentOneLine toolStatus={toolPart.status}>
          Running...
        </GenericToolPartContentOneLine>
      ) : (
        <BashToolResult result={toolPart.result} toolStatus={toolPart.status} />
      )}
    </GenericToolPart>
  );
}

function BashToolResult({
  result,
  toolStatus,
}: {
  result: string;
  toolStatus: AllToolParts["status"];
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const trimmedResult = useMemo(() => result.trim(), [result]);
  const linePreview = useMemo(
    () => createTextLinePreview(trimmedResult, 3),
    [trimmedResult],
  );

  const handleCopy = async () => {
    if (copied) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  if (trimmedResult === "") {
    return (
      <GenericToolPartContent toolStatus={toolStatus}>
        <GenericToolPartContentRow index={0}>
          <span className="text-muted-foreground">(no output)</span>
        </GenericToolPartContentRow>
      </GenericToolPartContent>
    );
  }

  if (linePreview.remainingLines === 0) {
    return (
      <GenericToolPartContent toolStatus={toolStatus}>
        {linePreview.previewLines.map((line, index) => (
          <GenericToolPartContentRow key={index} index={index}>
            <AnsiText text={line} />
          </GenericToolPartContentRow>
        ))}
      </GenericToolPartContent>
    );
  }

  if (!expanded) {
    return (
      <GenericToolPartContent toolStatus={toolStatus}>
        {linePreview.previewLines.map((line, index) => (
          <GenericToolPartContentRow key={index} index={index}>
            <span className="truncate block">
              <AnsiText text={line} />
            </span>
          </GenericToolPartContentRow>
        ))}
        <GenericToolPartContentRow index={-1}>
          <span>... +{linePreview.remainingLines} more lines</span>{" "}
          <GenericToolPartClickToExpand
            label="Show all"
            onClick={() => setExpanded(true)}
            isExpanded={false}
          />
        </GenericToolPartContentRow>
      </GenericToolPartContent>
    );
  }

  return (
    <GenericToolPartContent toolStatus={toolStatus}>
      <GenericToolPartContentRow index={0}>
        <span>
          <GenericToolPartClickToExpand
            label="Show less"
            onClick={() => setExpanded(false)}
            isExpanded={true}
          />
        </span>
      </GenericToolPartContentRow>
      <GenericToolPartContentRow
        index={-1}
        className="max-h-[300px] overflow-auto border border-border rounded-md p-1 mr-2 relative group/bash"
      >
        <button
          onClick={handleCopy}
          className="absolute top-1 right-1 p-1 rounded-md bg-muted/80 text-muted-foreground hover:text-foreground opacity-0 group-hover/bash:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
          title="Copy output"
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
        <pre>
          <AnsiText text={trimmedResult} />
        </pre>
      </GenericToolPartContentRow>
    </GenericToolPartContent>
  );
}

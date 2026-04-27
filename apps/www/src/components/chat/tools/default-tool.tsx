import React from "react";
import { AllToolParts } from "@terragon/shared";
import {
  GenericToolPart,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithPreview,
} from "./generic-ui";
import {
  formatToolParameters,
  getToolVerb,
  summarizeToolResult,
} from "./utils";
import { Plug } from "lucide-react";

function parseMcpToolName(name: string): {
  server: string;
  tool: string;
} | null {
  if (!name.startsWith("mcp__")) return null;
  // Format: mcp__serverName__toolName (split on __ delimiter)
  const parts = name.split("__");
  if (parts.length >= 3) {
    return { server: parts[1]!, tool: parts.slice(2).join("__") };
  }
  return null;
}

export function McpToolDisplay({
  serverName,
  toolName,
}: {
  serverName: string;
  toolName: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <Plug className="size-3" />
      <span>
        MCP: {serverName}::{toolName}
      </span>
    </span>
  );
}

export function DefaultTool({ toolPart }: { toolPart: AllToolParts }) {
  const mcpInfo = parseMcpToolName(toolPart.name);
  const displayName = mcpInfo ? (
    <McpToolDisplay serverName={mcpInfo.server} toolName={mcpInfo.tool} />
  ) : null;
  const toolArg = mcpInfo
    ? formatToolParameters(toolPart.parameters, {
        excludeKeys: ["server", "tool"],
      })
    : formatToolParameters(toolPart.parameters);

  return (
    <GenericToolPart
      toolName={displayName ?? toolPart.name}
      toolArg={toolArg}
      toolStatus={toolPart.status}
    >
      {toolPart.status === "pending" ? (
        <GenericToolPartContentOneLine toolStatus="pending">
          {getToolVerb(toolPart.name, "pending")}
        </GenericToolPartContentOneLine>
      ) : toolPart.status === "error" ? (
        <GenericToolPartContentResultWithPreview
          preview="Failed to run tool"
          content={toolPart.result}
          toolStatus="error"
        />
      ) : (
        <GenericToolPartContentResultWithPreview
          preview={summarizeToolResult(toolPart.result)}
          content={toolPart.result}
          toolStatus="completed"
        />
      )}
    </GenericToolPart>
  );
}

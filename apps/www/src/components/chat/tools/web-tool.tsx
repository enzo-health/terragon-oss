import React, { useState } from "react";
import { AllToolParts } from "@leo/shared";
import {
  GenericToolPart,
  GenericToolPartContent,
  GenericToolPartContentOneLine,
  GenericToolPartContentResultWithLines,
  GenericToolPartContentResultWithPreview,
  GenericToolPartContentRow,
  GenericToolPartClickToExpand,
} from "./generic-ui";

export function WebFetchTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "WebFetch" }>;
}) {
  return (
    <GenericToolPart
      toolName="Fetch"
      toolArg={toolPart.parameters.url}
      toolStatus={toolPart.status}
    >
      <WebFetchToolContent toolPart={toolPart} />
    </GenericToolPart>
  );
}

function WebFetchToolContent({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "WebFetch" }>;
}) {
  if (toolPart.status === "pending") {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        Fetching...
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
  const preview =
    toolPart.result.length > 200
      ? toolPart.result.slice(0, 200) + "..."
      : toolPart.result;
  return (
    <GenericToolPartContentResultWithPreview
      preview={preview}
      content={toolPart.result}
      toolStatus="completed"
      hidePreviewIfExpanded={true}
      wrapContentInPre={true}
    />
  );
}

export function WebSearchTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "WebSearch" }>;
}) {
  return (
    <GenericToolPart
      toolName="WebSearch"
      toolArg={toolPart.parameters.query}
      toolStatus={toolPart.status}
    >
      <WebSearchToolContent toolPart={toolPart} />
    </GenericToolPart>
  );
}

interface SearchResult {
  title: string;
  url: string;
}

function parseSearchResults(result: string): SearchResult[] {
  const results: SearchResult[] = [];
  // Match lines like: Title (https://url.com) or Title (http://url.com)
  const regex = /^(.+?)\s*\((https?:\/\/[^\s)]+)\)/gm;
  let match;
  while ((match = regex.exec(result)) !== null) {
    results.push({ title: match[1]!.trim(), url: match[2]! });
  }
  // Also match standalone URLs on their own lines if no title pattern matched them
  if (results.length === 0) {
    const urlRegex = /https?:\/\/[^\s)]+/g;
    let urlMatch;
    while ((urlMatch = urlRegex.exec(result)) !== null) {
      results.push({ title: urlMatch[0], url: urlMatch[0] });
    }
  }
  return results;
}

function WebSearchToolContent({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "WebSearch" }>;
}) {
  const [expanded, setExpanded] = useState(false);

  if (toolPart.status === "pending") {
    return (
      <GenericToolPartContentOneLine toolStatus="pending">
        Searching...
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

  const searchResults = parseSearchResults(toolPart.result);

  if (searchResults.length === 0) {
    return (
      <GenericToolPartContentOneLine toolStatus="completed">
        Done
      </GenericToolPartContentOneLine>
    );
  }

  const summary = `${searchResults.length} result${searchResults.length === 1 ? "" : "s"}`;
  const previewResults = searchResults.slice(0, 3);

  return (
    <GenericToolPartContent toolStatus="completed">
      <GenericToolPartContentRow index={0}>
        <span>
          {summary}{" "}
          <GenericToolPartClickToExpand
            label={expanded ? "Show less" : "Show all"}
            onClick={() => setExpanded((x) => !x)}
            isExpanded={expanded}
          />
        </span>
      </GenericToolPartContentRow>
      {!expanded &&
        previewResults.map((r, i) => (
          <GenericToolPartContentRow key={i} index={-1}>
            <a
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline truncate block"
            >
              {r.title}
            </a>
          </GenericToolPartContentRow>
        ))}
      {expanded &&
        searchResults.map((r, i) => (
          <GenericToolPartContentRow key={i} index={-1}>
            <a
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline truncate block"
            >
              {r.title}
            </a>
          </GenericToolPartContentRow>
        ))}
    </GenericToolPartContent>
  );
}

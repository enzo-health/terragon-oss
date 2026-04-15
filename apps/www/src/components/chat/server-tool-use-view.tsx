import { Globe } from "lucide-react";
import type { DBServerToolUsePart } from "@terragon/shared";

type ServerToolUseViewProps = {
  part: DBServerToolUsePart;
};

/**
 * Renders an Anthropic server-executed tool invocation (web_search,
 * code_execution, etc.). Distinct from ToolPart, which handles client-side
 * tools that require a round-trip to the agent for execution.
 *
 * The paired result arrives as a DBWebSearchResultPart (or similar) later in
 * the same agent message; this component renders just the invocation card.
 */
export function ServerToolUseView({ part }: ServerToolUseViewProps) {
  const queryText =
    typeof part.input?.query === "string" ? (part.input.query as string) : null;

  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
      <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="font-medium">{serverToolLabel(part.name)}</div>
        {queryText ? (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {queryText}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function serverToolLabel(name: string): string {
  switch (name) {
    case "web_search":
      return "Web search";
    case "code_execution":
      return "Code execution";
    default:
      return name;
  }
}

import React from "react";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ThreadMetaSnapshot } from "./use-thread-meta-events";

export interface McpServerHealthChipProps {
  mcpServerStatus: ThreadMetaSnapshot["mcpServerStatus"];
}

function SingleServerChip({
  name,
  status,
}: {
  name: string;
  status: "loading" | "ready" | "error";
}) {
  return (
    <div
      data-testid={`mcp-chip-${name}`}
      data-state={status}
      title={`MCP server: ${name} (${status})`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        {
          "border-border text-muted-foreground": status === "loading",
          "border-green-400 text-green-600": status === "ready",
          "border-red-400 text-red-600 bg-red-500/5": status === "error",
        },
      )}
    >
      {status === "loading" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : status === "ready" ? (
        <CheckCircle className="size-3" />
      ) : (
        <XCircle className="size-3" />
      )}
      MCP: {name}
    </div>
  );
}

/** One chip per known MCP server.  Hidden entirely if no servers reported yet. */
export function McpServerHealthChip({
  mcpServerStatus,
}: McpServerHealthChipProps) {
  const entries = Object.entries(mcpServerStatus);
  if (entries.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {entries.map(([name, status]) => (
        <SingleServerChip key={name} name={name} status={status} />
      ))}
    </div>
  );
}

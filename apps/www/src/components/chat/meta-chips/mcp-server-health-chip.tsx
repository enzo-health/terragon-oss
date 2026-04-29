import React from "react";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { MetaChip, type MetaChipVariant } from "./meta-chip";
import type { ThreadMetaSnapshot } from "./use-thread-meta-events";

export interface McpServerHealthChipProps {
  mcpServerStatus: ThreadMetaSnapshot["mcpServerStatus"];
}

const VARIANT_BY_STATUS: Record<
  "loading" | "ready" | "error",
  MetaChipVariant
> = {
  loading: "neutral",
  ready: "success",
  error: "danger",
};

function SingleServerChip({
  name,
  status,
}: {
  name: string;
  status: "loading" | "ready" | "error";
}) {
  const icon =
    status === "loading" ? (
      <Loader2 className="size-3 animate-spin" />
    ) : status === "ready" ? (
      <CheckCircle className="size-3" />
    ) : (
      <XCircle className="size-3" />
    );

  return (
    <MetaChip
      data-testid={`mcp-chip-${name}`}
      data-state={status}
      variant={VARIANT_BY_STATUS[status]}
      title={`MCP server: ${name} (${status})`}
      icon={icon}
    >
      MCP: {name}
    </MetaChip>
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

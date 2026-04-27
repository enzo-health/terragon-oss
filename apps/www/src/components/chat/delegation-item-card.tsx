import React, { useState } from "react";
import {
  CheckCircle,
  Circle,
  ChevronDown,
  ChevronRight,
  Loader2,
  XCircle,
  Users,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DBDelegationMessage } from "@terragon/shared";

type AgentStatus = "initiated" | "running" | "completed" | "failed";

function AgentStatusBadge({ status }: { status: AgentStatus }) {
  switch (status) {
    case "initiated":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-xs"
          data-status="initiated"
        >
          <Circle className="size-3" />
          Initiated
        </Badge>
      );
    case "running":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-xs border-blue-400 text-blue-600"
          data-status="running"
        >
          <Loader2 className="size-3 animate-spin" />
          Running
        </Badge>
      );
    case "completed":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-xs border-green-400 text-green-600"
          data-status="completed"
        >
          <CheckCircle className="size-3" />
          Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-xs border-red-400 text-red-600"
          data-status="failed"
        >
          <XCircle className="size-3" />
          Failed
        </Badge>
      );
  }
}

export interface DelegationItemCardProps {
  delegation: DBDelegationMessage;
}

export function DelegationItemCard({ delegation }: DelegationItemCardProps) {
  const [promptExpanded, setPromptExpanded] = useState(false);

  const agentCount = delegation.receiverThreadIds.length;
  const agentStates = delegation.agentsStates;

  return (
    <div className="rounded-lg border border-border bg-muted/30 text-sm p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium">
          <Users className="size-3.5 text-muted-foreground" />
          <span>
            Delegated to {agentCount} {agentCount === 1 ? "agent" : "agents"}
          </span>
        </div>
        <AgentStatusBadge status={delegation.status} />
      </div>

      {/* Per-agent status */}
      {Object.entries(agentStates).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(agentStates).map(([agentId, status]) => (
            <div
              key={agentId}
              className="flex items-center gap-1 text-xs text-muted-foreground"
            >
              <span
                className="font-mono truncate max-w-[100px]"
                title={agentId}
              >
                {agentId.slice(0, 8)}…
              </span>
              <AgentStatusBadge status={status} />
            </div>
          ))}
        </div>
      )}

      {/* Model + reasoning effort */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Zap className="size-3" />
        <span>{delegation.delegatedModel}</span>
        {delegation.reasoningEffort && (
          <span className="text-muted-foreground/70">
            · effort: {delegation.reasoningEffort}
          </span>
        )}
      </div>

      {/* Prompt (collapsible) */}
      <div>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setPromptExpanded((v) => !v)}
        >
          {promptExpanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          Prompt
        </button>
        {promptExpanded && (
          <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words pl-3">
            {delegation.prompt}
          </p>
        )}
      </div>
    </div>
  );
}

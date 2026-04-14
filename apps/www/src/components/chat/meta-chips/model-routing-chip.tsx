import React from "react";
import { AlertTriangle } from "lucide-react";
import type { ThreadMetaSnapshot } from "./use-thread-meta-events";

export interface ModelRoutingChipProps {
  modelReroute: ThreadMetaSnapshot["modelReroute"];
}

/** Warning chip — only visible when a model reroute event has been received. */
export function ModelRoutingChip({ modelReroute }: ModelRoutingChipProps) {
  if (!modelReroute) return null;

  return (
    <div
      data-testid="model-routing-chip"
      data-state="warning"
      title={`Model rerouted: ${modelReroute.originalModel} → ${modelReroute.reroutedModel}. Reason: ${modelReroute.reason}`}
      className="inline-flex items-center gap-1 rounded-full border border-amber-400 bg-amber-500/5 px-2 py-0.5 text-[11px] font-medium text-amber-600"
    >
      <AlertTriangle className="size-3" />
      Rerouted to {modelReroute.reroutedModel}
    </div>
  );
}

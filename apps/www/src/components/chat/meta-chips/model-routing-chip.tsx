import React from "react";
import { AlertTriangle } from "lucide-react";
import { MetaChip } from "./meta-chip";
import type { ThreadMetaSnapshot } from "./use-thread-meta-events";

export interface ModelRoutingChipProps {
  modelReroute: ThreadMetaSnapshot["modelReroute"];
}

/** Warning chip — only visible when a model reroute event has been received. */
export function ModelRoutingChip({ modelReroute }: ModelRoutingChipProps) {
  if (!modelReroute) return null;

  return (
    <MetaChip
      data-testid="model-routing-chip"
      data-state="warning"
      variant="warning"
      title={`Model rerouted: ${modelReroute.originalModel} → ${modelReroute.reroutedModel}. Reason: ${modelReroute.reason}`}
      icon={<AlertTriangle className="size-3" />}
    >
      Rerouted to {modelReroute.reroutedModel}
    </MetaChip>
  );
}

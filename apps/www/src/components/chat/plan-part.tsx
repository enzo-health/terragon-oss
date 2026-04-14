import React from "react";
import { CheckCircle, Circle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DBPlanPart } from "@terragon/shared";

type PlanEntry = DBPlanPart["entries"][number];

function PriorityStripe({ priority }: { priority: PlanEntry["priority"] }) {
  return (
    <span
      aria-label={`Priority: ${priority}`}
      data-priority={priority}
      className={cn("shrink-0 w-1 self-stretch rounded-full", {
        "bg-red-500": priority === "high",
        "bg-amber-400": priority === "medium",
        "bg-muted-foreground/30": priority === "low",
      })}
    />
  );
}

function StatusIcon({ status }: { status: PlanEntry["status"] }) {
  switch (status) {
    case "pending":
      return (
        <Circle
          className="size-4 text-muted-foreground/50 shrink-0"
          data-status="pending"
          aria-label="Pending"
        />
      );
    case "in_progress":
      return (
        <Loader2
          className="size-4 text-blue-500 animate-spin shrink-0"
          data-status="in_progress"
          aria-label="In progress"
        />
      );
    case "completed":
      return (
        <CheckCircle
          className="size-4 text-green-500 shrink-0"
          data-status="completed"
          aria-label="Completed"
        />
      );
  }
}

export interface PlanPartViewProps {
  part: DBPlanPart;
}

export function PlanPartView({ part }: PlanPartViewProps) {
  if (part.entries.length === 0) {
    return (
      <div className="text-sm text-muted-foreground italic">Empty plan</div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {part.entries.map((entry, index) => (
        <div key={entry.id ?? index} className="flex items-start gap-2 min-h-6">
          <PriorityStripe priority={entry.priority} />
          <StatusIcon status={entry.status} />
          <span
            className={cn("leading-tight pt-0.5", {
              "text-muted-foreground line-through":
                entry.status === "completed",
            })}
          >
            {entry.content}
          </span>
        </div>
      ))}
    </div>
  );
}

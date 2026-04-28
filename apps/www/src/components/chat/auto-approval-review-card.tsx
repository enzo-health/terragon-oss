import React from "react";
import {
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  ShieldCheck,
  Shield,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { DBAutoApprovalReviewPart } from "@terragon/shared";

function RiskLevelPill({
  riskLevel,
}: {
  riskLevel: DBAutoApprovalReviewPart["riskLevel"];
}) {
  return (
    <Badge
      variant="outline"
      data-risk={riskLevel}
      className={cn("gap-1 text-xs", {
        "border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/50 dark:bg-emerald-400/10 dark:text-emerald-300":
          riskLevel === "low",
        "border-amber-500/70 bg-amber-500/10 text-amber-700 dark:border-amber-400/60 dark:bg-amber-400/10 dark:text-amber-300":
          riskLevel === "medium",
        "border-red-500/70 bg-red-500/10 text-red-700 dark:border-red-400/60 dark:bg-red-400/10 dark:text-red-300":
          riskLevel === "high",
      })}
    >
      {riskLevel === "high" ? (
        <AlertTriangle className="size-3" />
      ) : riskLevel === "medium" ? (
        <Shield className="size-3" />
      ) : (
        <ShieldCheck className="size-3" />
      )}
      {riskLevel} risk
    </Badge>
  );
}

function DecisionBadge({
  status,
}: {
  status: DBAutoApprovalReviewPart["status"];
}) {
  switch (status) {
    case "pending":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-xs"
          data-decision="pending"
        >
          <Clock className="size-3" />
          Pending
        </Badge>
      );
    case "approved":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-xs border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/50 dark:bg-emerald-400/10 dark:text-emerald-300"
          data-decision="approved"
        >
          <CheckCircle className="size-3" />
          Approved
        </Badge>
      );
    case "denied":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-xs border-red-500/70 bg-red-500/10 text-red-700 dark:border-red-400/60 dark:bg-red-400/10 dark:text-red-300"
          data-decision="denied"
        >
          <XCircle className="size-3" />
          Denied
        </Badge>
      );
  }
}

export interface AutoApprovalReviewCardProps {
  part: DBAutoApprovalReviewPart;
}

export function AutoApprovalReviewCard({ part }: AutoApprovalReviewCardProps) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 text-sm p-3 space-y-2">
      {/* Header: action + risk */}
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-foreground line-clamp-2">
          {part.action}
        </span>
        <RiskLevelPill riskLevel={part.riskLevel} />
      </div>

      {/* Rationale */}
      {part.rationale && (
        <p className="text-xs text-muted-foreground leading-relaxed">
          {part.rationale}
        </p>
      )}

      {/* Decision */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Decision:</span>
        <DecisionBadge status={part.status} />
      </div>
    </div>
  );
}

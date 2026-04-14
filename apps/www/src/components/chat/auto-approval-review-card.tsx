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
        "border-green-400 text-green-600": riskLevel === "low",
        "border-amber-400 text-amber-600": riskLevel === "medium",
        "border-red-400 text-red-600": riskLevel === "high",
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
          className="gap-1 text-xs border-green-400 text-green-600"
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
          className="gap-1 text-xs border-red-400 text-red-600"
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

import React, { useState } from "react";
import {
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DBDiffPart } from "@terragon/shared";

export interface DiffPartViewProps {
  part: DBDiffPart;
  onAccept?: () => void;
  onReject?: () => void;
}

function StatusBadge({ status }: { status: DBDiffPart["status"] }) {
  switch (status) {
    case "pending":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-xs"
          data-status="pending"
        >
          <Clock className="size-3" />
          Pending
        </Badge>
      );
    case "applied":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-xs border-[var(--diff-added-border)] text-[var(--diff-added-fg)]"
          data-status="applied"
        >
          <CheckCircle className="size-3" />
          Applied
        </Badge>
      );
    case "rejected":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-xs border-[var(--diff-removed-border)] text-[var(--diff-removed-fg)]"
          data-status="rejected"
        >
          <XCircle className="size-3" />
          Rejected
        </Badge>
      );
  }
}

export function DiffPartView({ part, onAccept, onReject }: DiffPartViewProps) {
  const [expanded, setExpanded] = useState(false);
  const diffContent = part.unifiedDiff || buildSimpleDiff(part);

  return (
    <div className="rounded-lg border border-border text-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/40">
        <button
          type="button"
          className="flex items-center gap-1.5 font-mono text-xs font-medium truncate hover:text-foreground transition-colors text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )}
          <span className="truncate">{part.filePath}</span>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={part.status} />
          {part.status === "pending" && (onAccept || onReject) && (
            <div className="flex gap-1">
              {onAccept && (
                <button
                  type="button"
                  onClick={onAccept}
                  className="rounded px-2 py-0.5 text-xs bg-[var(--diff-added-bg)] text-[var(--diff-added-fg)] hover:bg-[var(--diff-added-bg-hover)] transition-colors border border-[var(--diff-added-border)]"
                >
                  Accept
                </button>
              )}
              {onReject && (
                <button
                  type="button"
                  onClick={onReject}
                  className="rounded px-2 py-0.5 text-xs bg-[var(--diff-removed-bg)] text-[var(--diff-removed-fg)] hover:bg-[var(--diff-removed-bg-hover)] transition-colors border border-[var(--diff-removed-border)]"
                >
                  Reject
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Diff body */}
      {expanded && diffContent && (
        <div className="overflow-x-auto">
          <pre className="text-xs font-mono p-3 leading-relaxed">
            <code>
              {diffContent.split("\n").map((line, i) => (
                // Use <span> with display:block so the markup stays inside
                // the phrasing-content contract of <pre><code>. <div> inside
                // <pre> is invalid HTML and renders inconsistently.
                <span
                  key={i}
                  className={`block ${
                    line.startsWith("+")
                      ? "bg-[var(--diff-added-bg)] text-[var(--diff-added-fg)]"
                      : line.startsWith("-")
                        ? "bg-[var(--diff-removed-bg)] text-[var(--diff-removed-fg)]"
                        : line.startsWith("@@")
                          ? "text-blue-600 dark:text-blue-400"
                          : "text-muted-foreground"
                  }`}
                >
                  {line || "\u00A0"}
                </span>
              ))}
            </code>
          </pre>
        </div>
      )}
    </div>
  );
}

/** Fallback: build a minimal diff from old/new content when unifiedDiff is absent. */
function buildSimpleDiff(part: DBDiffPart): string {
  if (!part.newContent) return "";
  const lines: string[] = [];
  lines.push(`--- a/${part.filePath}`);
  lines.push(`+++ b/${part.filePath}`);
  if (part.oldContent) {
    for (const line of part.oldContent.split("\n")) {
      lines.push(`-${line}`);
    }
  }
  for (const line of part.newContent.split("\n")) {
    lines.push(`+${line}`);
  }
  return lines.join("\n");
}

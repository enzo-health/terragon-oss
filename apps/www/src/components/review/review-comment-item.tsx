"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { TicketIcon } from "lucide-react";
import {
  toggleCommentInclusion,
  cycleCommentPriority,
  updateCommentBody,
} from "@/server-actions/review-detail";
import type {
  ReviewCommentDetail,
  ReviewCommentPriority,
  ReviewCommentResolution,
} from "@/types/review";

const PRIORITY_COLORS: Record<ReviewCommentPriority, string> = {
  high: "bg-red-500/15 text-red-400 border-red-500/30",
  medium: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  low: "bg-blue-500/15 text-blue-400 border-blue-500/30",
};

const PRIORITY_ORDER: ReviewCommentPriority[] = ["high", "medium", "low"];

const RESOLUTION_CONFIG: Record<
  ReviewCommentResolution,
  { label: string; className: string }
> = {
  resolved: {
    label: "Resolved",
    className: "bg-emerald-500/15 text-emerald-400",
  },
  partially_resolved: {
    label: "Partial",
    className: "bg-amber-500/15 text-amber-400",
  },
  not_addressed: {
    label: "Not Addressed",
    className: "bg-red-500/15 text-red-400",
  },
};

interface ReviewCommentItemProps {
  comment: ReviewCommentDetail;
  onOptimisticUpdate: (
    commentId: string,
    updates: Partial<ReviewCommentDetail>,
  ) => void;
}

export function ReviewCommentItem({
  comment,
  onOptimisticUpdate,
}: ReviewCommentItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isPending, startTransition] = useTransition();

  const handleToggleIncluded = useCallback(() => {
    onOptimisticUpdate(comment.id, { included: !comment.included });
    startTransition(async () => {
      await toggleCommentInclusion(comment.id);
    });
  }, [comment.id, comment.included, onOptimisticUpdate]);

  const handleCyclePriority = useCallback(() => {
    const currentIdx = PRIORITY_ORDER.indexOf(comment.priority);
    const nextPriority =
      PRIORITY_ORDER[(currentIdx + 1) % PRIORITY_ORDER.length];
    onOptimisticUpdate(comment.id, { priority: nextPriority });
    startTransition(async () => {
      await cycleCommentPriority(comment.id);
    });
  }, [comment.id, comment.priority, onOptimisticUpdate]);

  const handleStartEdit = useCallback(() => {
    setEditBody(comment.body);
    setIsEditing(true);
    // Focus textarea on next tick
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [comment.body]);

  const handleSaveEdit = useCallback(() => {
    if (editBody.trim() === comment.body) {
      setIsEditing(false);
      return;
    }
    onOptimisticUpdate(comment.id, { body: editBody.trim() });
    setIsEditing(false);
    startTransition(async () => {
      await updateCommentBody(comment.id, editBody.trim());
    });
  }, [comment.id, comment.body, editBody, onOptimisticUpdate]);

  const handleCancelEdit = useCallback(() => {
    setEditBody(comment.body);
    setIsEditing(false);
  }, [comment.body]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSaveEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancelEdit();
      }
    },
    [handleSaveEdit, handleCancelEdit],
  );

  const isHuman = comment.authorUserId != null;
  const isPreExisting = comment.introducedByPr === false;

  return (
    <div
      className={cn(
        "group flex gap-3 rounded-lg border border-border/50 p-3 transition-all",
        comment.included ? "bg-card/50" : "bg-muted/20 opacity-60",
        isPending && "opacity-70",
      )}
    >
      {/* Checkbox */}
      <div className="pt-0.5 shrink-0">
        <Checkbox
          checked={comment.included}
          onCheckedChange={handleToggleIncluded}
          aria-label={comment.included ? "Exclude comment" : "Include comment"}
        />
      </div>

      {/* Content */}
      <div className="flex flex-col gap-1.5 min-w-0 flex-1">
        {/* Header row: priority + file + tags */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Priority badge (clickable) */}
          <button
            type="button"
            onClick={handleCyclePriority}
            className="cursor-pointer"
            title="Click to cycle priority"
          >
            <Badge
              className={cn(
                "text-[10px] uppercase tracking-wider border cursor-pointer select-none",
                PRIORITY_COLORS[comment.priority],
              )}
            >
              {comment.priority}
            </Badge>
          </button>

          {/* File location */}
          <span className="text-xs font-mono text-muted-foreground truncate">
            {comment.file}
            {comment.line != null ? `:${comment.line}` : ""}
          </span>

          {/* Tags */}
          {isPreExisting && (
            <Badge
              variant="outline"
              className="text-[10px] text-muted-foreground/70"
            >
              Pre-existing
            </Badge>
          )}
          {isHuman && (
            <Badge className="text-[10px] bg-blue-500/15 text-blue-400 border-blue-500/30 border">
              Human
            </Badge>
          )}
          {comment.resolution && (
            <Badge
              className={cn(
                "text-[10px]",
                RESOLUTION_CONFIG[comment.resolution].className,
              )}
            >
              {RESOLUTION_CONFIG[comment.resolution].label}
            </Badge>
          )}
        </div>

        {/* Body */}
        {isEditing ? (
          <Textarea
            ref={textareaRef}
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            onBlur={handleSaveEdit}
            onKeyDown={handleKeyDown}
            className="min-h-[60px] text-sm"
            placeholder="Comment body..."
          />
        ) : (
          <button
            type="button"
            onClick={handleStartEdit}
            className="text-left text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed hover:text-foreground transition-colors cursor-text"
          >
            {comment.body}
          </button>
        )}
      </div>

      {/* Triage button */}
      <div className="shrink-0 pt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          title="Create ticket (coming soon)"
        >
          <TicketIcon className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

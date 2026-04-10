"use client";

import { Badge } from "@/components/ui/badge";
import { ExternalLinkIcon, MessageSquareIcon } from "lucide-react";
import type { ReviewBotFeedback as BotFeedbackType } from "@/types/review";

interface ReviewBotFeedbackProps {
  feedback: BotFeedbackType[];
}

export function ReviewBotFeedback({ feedback }: ReviewBotFeedbackProps) {
  if (feedback.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <MessageSquareIcon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          Unresolved Bot Reviews
        </h3>
        <Badge variant="outline" className="text-xs">
          {feedback.length}
        </Badge>
      </div>
      <div className="flex flex-col gap-2">
        {feedback.map((item, idx) => (
          <div
            key={`${item.url}-${idx}`}
            className="rounded-lg border border-border/50 bg-muted/30 p-3 text-sm"
          >
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium text-foreground truncate">
                  {item.author}
                </span>
                {item.file && (
                  <span className="text-xs text-muted-foreground font-mono truncate">
                    {item.file}
                    {item.line != null ? `:${item.line}` : ""}
                  </span>
                )}
              </div>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              >
                <ExternalLinkIcon className="h-3.5 w-3.5" />
              </a>
            </div>
            <p className="text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {item.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

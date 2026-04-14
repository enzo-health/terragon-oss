import React from "react";
import { ExternalLink, File } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DBResourceLinkPart } from "@terragon/shared";

export interface ResourceLinkViewProps {
  part: DBResourceLinkPart;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ResourceLinkView({ part }: ResourceLinkViewProps) {
  return (
    <a
      href={part.uri}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm hover:bg-muted/50 transition-colors group no-underline"
    >
      <File className="size-5 text-muted-foreground shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-foreground truncate">
            {part.title || part.name}
          </span>
          <ExternalLink className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
        </div>
        {part.title && part.name !== part.title && (
          <div className="text-xs text-muted-foreground truncate">
            {part.name}
          </div>
        )}
        {part.description && (
          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {part.description}
          </div>
        )}
        <div className="flex gap-1.5 mt-1.5 flex-wrap">
          {part.mimeType && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {part.mimeType}
            </Badge>
          )}
          {part.size != null && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {formatSize(part.size)}
            </Badge>
          )}
        </div>
      </div>
    </a>
  );
}

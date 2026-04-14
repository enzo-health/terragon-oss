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

const SAFE_URI_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * ACP `resource_link` payloads originate from the sandbox-agent, which can
 * in turn receive a URI from agent tool output. `javascript:` (and other
 * dangerous schemes) embedded in that field would execute on click.
 * Allowlist the safe schemes and render a non-clickable fallback for
 * anything else so the user can still see the referenced name/description.
 */
function sanitizeHref(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    return SAFE_URI_SCHEMES.has(parsed.protocol) ? uri : null;
  } catch {
    // Relative URLs (no scheme) are fine — they cannot escape the origin.
    if (/^\//.test(uri) || /^\.{1,2}\//.test(uri)) return uri;
    return null;
  }
}

export function ResourceLinkView({ part }: ResourceLinkViewProps) {
  const safeHref = sanitizeHref(part.uri);
  const cardClass =
    "flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm group no-underline";

  const content = (
    <>
      <File className="size-5 text-muted-foreground shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-foreground truncate">
            {part.title || part.name}
          </span>
          {safeHref && (
            <ExternalLink className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
          )}
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
          {!safeHref && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              unsafe URI
            </Badge>
          )}
        </div>
      </div>
    </>
  );

  if (safeHref) {
    return (
      <a
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        className={`${cardClass} hover:bg-muted/50 transition-colors`}
      >
        {content}
      </a>
    );
  }

  // Non-safe scheme: render a non-clickable card with the metadata still
  // visible to the user (including the raw uri so they can inspect it).
  return (
    <div
      className={cardClass}
      title={`Blocked URI scheme: ${part.uri}`}
      data-blocked-uri={part.uri}
    >
      {content}
    </div>
  );
}

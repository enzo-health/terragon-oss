import { AlertCircle, ExternalLink } from "lucide-react";
import type { DBWebSearchResultPart } from "@terragon/shared";

type WebSearchResultViewProps = {
  part: DBWebSearchResultPart;
};

/**
 * Renders the result of a server-side `web_search` invocation. Either shows
 * a list of hits (url + title) or an error code; both-missing is rendered as
 * an empty-result notice so operators still see that the search ran.
 */
export function WebSearchResultView({ part }: WebSearchResultViewProps) {
  if (part.errorCode) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-medium text-destructive">Web search failed</div>
          <div className="text-xs text-muted-foreground">{part.errorCode}</div>
        </div>
      </div>
    );
  }

  const results = part.results ?? [];
  if (results.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        No results.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        {results.length} {results.length === 1 ? "result" : "results"}
      </div>
      <ul className="space-y-1.5">
        {results.map((r, idx) => (
          <li key={`${r.url}-${idx}`} className="min-w-0">
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer noopener"
              className="group flex items-start gap-1.5 text-foreground hover:underline"
            >
              <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground group-hover:text-foreground" />
              <span className="min-w-0 truncate">{r.title}</span>
            </a>
            <div className="truncate text-xs text-muted-foreground pl-[1.125rem]">
              {prettyUrl(r.url)}
              {r.pageAge ? ` · ${r.pageAge}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

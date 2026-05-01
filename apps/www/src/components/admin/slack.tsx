"use client";

import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { parseSlackUrl } from "@/server-actions/admin/slack";

export function AdminSlackMessageDebugger() {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Slack Message Debugger" },
  ]);

  const [url, setUrl] = useState("");
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setOutput(null);

    try {
      const result = await parseSlackUrl(url);
      if (result.success) {
        setOutput(result.message);
      } else {
        setError(result.error || "Unknown error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-4xl">
      <p className="text-muted-foreground mb-6">
        Paste a Slack message URL to see the output of buildSlackMentionMessage
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="slack-url" className="block text-sm font-medium mb-2">
            Slack Message URL
          </label>
          <Textarea
            id="slack-url"
            placeholder="https://workspace.slack.com/archives/C1234567890/p1234567890123456"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="font-mono text-sm"
            rows={3}
          />
        </div>

        <Button type="submit" disabled={isLoading || !url.trim()}>
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Parsing...
            </>
          ) : (
            "Parse URL"
          )}
        </Button>
      </form>

      {error && (
        <div className="mt-6 p-4 bg-[var(--error)]/10 border border-[var(--error)]/40 rounded-2xl">
          <h2 className="text-lg font-semibold text-[var(--error)] mb-2">
            Error
          </h2>
          <p className="text-sm text-[var(--error)]/90 whitespace-pre-wrap font-mono">
            {error}
          </p>
        </div>
      )}

      {output && (
        <div className="mt-6 p-4 bg-[var(--card-cream,var(--card))] rounded-2xl border border-[var(--hairline,var(--border))]">
          <h2 className="text-lg font-semibold mb-2">
            buildSlackMentionMessage Output
          </h2>
          <pre className="text-sm whitespace-pre-wrap font-mono bg-[var(--code-floor,var(--muted))] text-[var(--on-dark,var(--foreground))] p-4 rounded-xl border border-[var(--hairline,var(--border))]">
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}

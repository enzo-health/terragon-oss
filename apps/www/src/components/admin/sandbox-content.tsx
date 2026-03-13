"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getSandboxDaemonLogs } from "@/server-actions/admin/sandbox";
import { Loader2, Download } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import type { SandboxProvider } from "@terragon/types/sandbox";

async function fetchLogs({
  sandboxProvider,
  sandboxId,
  setLogLines,
  setIsLoadingLogs,
}: {
  sandboxProvider: SandboxProvider;
  sandboxId: string;
  setLogLines: (logLines: string[]) => void;
  setIsLoadingLogs: (isLoading: boolean) => void;
}) {
  if (!sandboxId) {
    return;
  }
  setIsLoadingLogs(true);
  try {
    const logLines = await getSandboxDaemonLogs({
      sandboxProvider,
      sandboxId,
    });
    setLogLines(logLines);
  } catch (error) {
    setLogLines(["Failed to fetch logs", String(error)]);
  } finally {
    setIsLoadingLogs(false);
  }
}

export function AdminSandboxContent(props: {
  sandboxProvider: SandboxProvider | null;
  sandboxId: string | null;
}) {
  const router = useRouter();
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Sandboxes", href: "/internal/admin/sandbox" },
    ...(props.sandboxId ? [{ label: props.sandboxId }] : []),
  ]);

  const [sandboxId, setSandboxId] = useState(props.sandboxId ?? "");
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);

  const handleDownloadLog = () => {
    if (!logLines || logLines.length === 0) return;

    const logContent = logLines.join("\n");
    const blob = new Blob([logContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `terragon-daemon-${props.sandboxId}-${timestamp}.log`;

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (props.sandboxId && props.sandboxProvider) {
      fetchLogs({
        sandboxProvider: props.sandboxProvider,
        sandboxId: props.sandboxId,
        setLogLines,
        setIsLoadingLogs,
      });
    }
  }, [props.sandboxId, props.sandboxProvider]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <div className="flex flex-col flex-1 mt-4 min-h-0 pb-4">
        <div className="flex gap-2 mb-6">
          <Input
            placeholder="Enter E2B Sandbox ID..."
            className="font-mono text-sm"
            value={sandboxId}
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                router.push(`/internal/admin/sandbox/${sandboxId}`);
              }
            }}
            onChange={(e) => {
              setSandboxId(e.currentTarget.value);
            }}
          />
          <Button
            variant="outline"
            onClick={() => {
              router.push(`/internal/admin/sandbox/${sandboxId}`);
            }}
          >
            Submit
          </Button>
        </div>
        {props.sandboxId && (
          <div className="flex flex-col flex-1 min-h-0 border rounded-lg overflow-hidden">
            <div className="flex w-full items-center justify-between px-4 py-2 border-b bg-muted/50">
              <h3 className="text-sm font-semibold">
                /tmp/terragon-daemon.log
              </h3>
              <div className="flex items-center gap-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadLog}
                  disabled={!logLines || logLines.length === 0 || isLoadingLogs}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download
                </Button>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="wrap-lines"
                    checked={wrapLines}
                    onCheckedChange={(checked) =>
                      setWrapLines(checked === true)
                    }
                  />
                  <label htmlFor="wrap-lines" className="text-sm font-medium">
                    Wrap
                  </label>
                </div>
              </div>
            </div>
            {isLoadingLogs && (
              <div className="flex p-4 h-64 items-center justify-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading Logs...
              </div>
            )}
            {logLines && (
              <ScrollArea className="flex-1 overflow-auto [&>div]:w-fit">
                <div className="flex flex-col gap-1 font-mono text-sm p-4 w-fit">
                  {logLines.map((logLine, index) => (
                    <div key={index} className="flex">
                      <span
                        className={cn(
                          wrapLines
                            ? "whitespace-pre-wrap break-all"
                            : "whitespace-pre",
                        )}
                      >
                        {logLine}
                      </span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

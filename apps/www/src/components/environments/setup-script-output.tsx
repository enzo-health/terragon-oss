"use client";

import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { SandboxOutput } from "@/hooks/use-setup-script";
import { ansiToHtml } from "@/components/chat/tools/utils";
import { useTheme } from "next-themes";
import stripAnsi from "strip-ansi";

export function SetupScriptOutput({
  outputs,
  isRunning,
}: {
  outputs: SandboxOutput[];
  isRunning: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "light" ? "light" : "dark";

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new output is added
  useEffect(() => {
    // Auto-scroll to bottom when new output is added
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [outputs]);

  const handleCopy = async () => {
    if (copied) {
      return;
    }
    try {
      const outputText = outputs
        .map((output) => stripAnsi(output.content))
        .join("");
      await navigator.clipboard.writeText(outputText);
      toast.success("Output copied to clipboard");
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      toast.error("Failed to copy output");
    }
  };

  if (outputs.length === 0 && !isRunning) {
    return null;
  }
  return (
    <div className="relative border rounded-md bg-black/95 font-mono text-sm overflow-auto max-h-[500px]">
      {outputs.length > 0 && (
        <Button
          onClick={handleCopy}
          variant="ghost"
          size="sm"
          className="sticky top-2 right-2 z-10 h-7 px-2 bg-black/50 hover:bg-black/70 text-gray-400 hover:text-gray-200 float-right mr-2 mt-2"
          title="Copy output"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 mr-1" />
              <span className="text-xs">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3 mr-1" />
              <span className="text-xs">Copy</span>
            </>
          )}
        </Button>
      )}
      <div className="p-4 space-y-0">
        {outputs.map((output, index) => (
          <div
            key={index}
            className={cn(
              "whitespace-pre-wrap break-all",
              output.type === "stdout" && "text-gray-100",
              output.type === "stderr" && "text-red-400",
              output.type === "error" && "text-red-500 font-semibold",
            )}
            dangerouslySetInnerHTML={{
              __html: ansiToHtml(output.content, theme),
            }}
          />
        ))}
        {isRunning && (
          <div className="text-gray-400">
            <span className="text-muted-foreground">Running...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { X, Terminal, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { isSandboxTerminalSupported } from "@/lib/sandbox-terminal";
import { SandboxTerminalEmbedded } from "@/components/terminal/sandbox-terminal-embedded";
import type { SandboxProvider } from "@terragon/types/sandbox";

export function TerminalPanel({
  threadId,
  sandboxId,
  sandboxProvider,
  onClose,
}: {
  threadId: string;
  sandboxId: string;
  sandboxProvider: SandboxProvider;
  onClose: () => void;
}) {
  const [isMinimized, setIsMinimized] = useState(false);

  return (
    <div
      className={cn(
        // Brand: code & terminal surfaces are always dark navy product chrome,
        // regardless of light/dark theme. The cream-to-dark contrast is part of
        // the visual rhythm.
        "absolute bottom-0 bg-surface-dark text-on-dark border border-b-0 border-surface-dark-elevated rounded-t-lg z-50 flex flex-col shadow-lg origin-bottom-right transition-[opacity,transform] duration-200 ease-out",
        isMinimized
          ? "h-10 !w-[200px] right-2 sm:right-12"
          : "max-h-[80vh] sm:h-[640px] w-auto right-2 left-2 sm:w-[600px] sm:right-12 sm:left-auto",
      )}
    >
      {/* Terminal header */}
      <div
        className={cn(
          "flex items-center justify-between h-10 bg-surface-dark-elevated rounded-t-lg p-2 text-on-dark",
          !isMinimized && "border-b border-surface-dark-elevated",
        )}
        onClick={() => {
          if (isMinimized) {
            setIsMinimized(false);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          <span className="text-sm font-medium">Terminal</span>
        </div>
        <div className="flex items-center gap-1">
          {!isMinimized && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setIsMinimized(true)}
            >
              <Minus className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className={cn("flex flex-col flex-1", isMinimized && "hidden")}>
        {isSandboxTerminalSupported(sandboxProvider) ? (
          <SandboxTerminalEmbedded
            threadId={threadId}
            sandboxId={sandboxId}
            sandboxProvider={sandboxProvider}
            minimized={isMinimized}
          />
        ) : (
          <SandboxTerminalUnsupported />
        )}
      </div>
    </div>
  );
}

function SandboxTerminalUnsupported() {
  return (
    <div className="h-full">
      <div className="flex items-center justify-between border-b px-2 py-1 text-sm bg-muted h-10">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-muted-foreground/50" />
          {/* TODO: Add a link to docs about this */}
          <span>Sorry, this sandbox does not support terminal access.</span>
        </div>
      </div>
    </div>
  );
}

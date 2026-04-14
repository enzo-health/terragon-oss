import React from "react";
import { AlertTriangle, LayoutDashboard, Loader2 } from "lucide-react";

export function ArtifactWorkspaceState({
  title,
  description,
  variant = "empty",
}: {
  title: string;
  description: string;
  variant?: "empty" | "loading" | "error";
}) {
  if (variant === "loading") {
    return (
      <div className="flex flex-col gap-4 p-6 animate-in fade-in duration-150">
        <div className="flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground/70" />
          <span className="text-xs font-medium text-muted-foreground">
            {title}
          </span>
        </div>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="h-3.5 w-3.5 rounded bg-muted animate-pulse [animation-duration:1.5s]" />
            <div className="h-3.5 w-32 rounded bg-muted animate-pulse [animation-duration:1.5s]" />
          </div>
          <div className="space-y-1.5 pl-5">
            <div className="h-3 w-full rounded bg-muted/70 animate-pulse [animation-duration:1.5s] [animation-delay:50ms]" />
            <div className="h-3 w-4/5 rounded bg-muted/70 animate-pulse [animation-duration:1.5s] [animation-delay:100ms]" />
            <div className="h-3 w-3/5 rounded bg-muted/70 animate-pulse [animation-duration:1.5s] [animation-delay:150ms]" />
            <div className="h-3 w-11/12 rounded bg-muted/70 animate-pulse [animation-duration:1.5s] [animation-delay:200ms]" />
            <div className="h-3 w-2/3 rounded bg-muted/70 animate-pulse [animation-duration:1.5s] [animation-delay:250ms]" />
          </div>
          <div className="flex items-center gap-2 pt-2">
            <div className="h-3.5 w-3.5 rounded bg-muted animate-pulse [animation-duration:1.5s] [animation-delay:300ms]" />
            <div className="h-3.5 w-40 rounded bg-muted animate-pulse [animation-duration:1.5s] [animation-delay:300ms]" />
          </div>
          <div className="space-y-1.5 pl-5">
            <div className="h-3 w-full rounded bg-muted/70 animate-pulse [animation-duration:1.5s] [animation-delay:350ms]" />
            <div className="h-3 w-3/4 rounded bg-muted/70 animate-pulse [animation-duration:1.5s] [animation-delay:400ms]" />
            <div className="h-3 w-5/6 rounded bg-muted/70 animate-pulse [animation-duration:1.5s] [animation-delay:450ms]" />
          </div>
        </div>
      </div>
    );
  }

  if (variant === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="rounded-lg bg-destructive/10 p-3">
          <AlertTriangle className="size-6 text-destructive/60" />
        </div>
        <div>
          <p className="text-sm font-medium text-destructive">{title}</p>
          <p className="mt-1 text-xs text-muted-foreground/60">{description}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="rounded-lg bg-muted/50 p-3">
        <LayoutDashboard className="size-6 text-muted-foreground/60" />
      </div>
      <div>
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground/60">{description}</p>
      </div>
    </div>
  );
}

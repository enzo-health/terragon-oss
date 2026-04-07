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
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{title}</span>
        </div>
        <div className="space-y-2">
          <div className="h-8 rounded bg-muted animate-pulse" />
          <div className="h-4 w-3/4 rounded bg-muted animate-pulse" />
          <div className="h-4 w-1/2 rounded bg-muted animate-pulse" />
          <div className="h-4 w-5/6 rounded bg-muted animate-pulse" />
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

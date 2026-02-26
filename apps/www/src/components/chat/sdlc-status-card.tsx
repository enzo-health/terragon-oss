"use client";

import { useSdlcLoopStatusQuery } from "@/queries/sdlc-loop-status-queries";
import type { SdlcLoopStatusCheckStatus } from "@/lib/sdlc-loop-status";
import { cn } from "@/lib/utils";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink } from "lucide-react";

function getCheckStatusLabel(status: SdlcLoopStatusCheckStatus): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "blocked":
      return "Blocked";
    case "degraded":
      return "Degraded";
    case "not_started":
      return "Not started";
    default:
      return "Pending";
  }
}

function getCheckBadgeVariant(
  status: SdlcLoopStatusCheckStatus,
): BadgeProps["variant"] {
  switch (status) {
    case "blocked":
      return "destructive";
    case "passed":
      return "secondary";
    default:
      return "outline";
  }
}

function getCheckBadgeClassName(status: SdlcLoopStatusCheckStatus): string {
  switch (status) {
    case "passed":
      return "text-emerald-700 bg-emerald-500/10 border-emerald-500/30 dark:text-emerald-300";
    case "degraded":
      return "text-amber-700 bg-amber-500/10 border-amber-500/30 dark:text-amber-300";
    default:
      return "";
  }
}

function ExternalStatusLink({
  label,
  href,
}: {
  label: string;
  href: string | null;
}) {
  if (!href) {
    return (
      <div className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground">
        {label}: unavailable
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-md border px-2 py-1.5 text-xs hover:bg-muted transition-colors inline-flex items-center justify-between gap-1.5"
      aria-label={`Open ${label}`}
    >
      <span>{label}</span>
      <ExternalLink className="h-3 w-3 text-muted-foreground" />
    </a>
  );
}

function SdlcStatusCardSkeleton() {
  return (
    <Card className="py-3 gap-3">
      <CardHeader className="px-4 pb-0 gap-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-1.5 w-full" />
      </CardHeader>
      <CardContent className="px-4 pt-0 space-y-2">
        <Separator />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </CardContent>
    </Card>
  );
}

export function SdlcStatusCard({
  threadId,
  enabled,
}: {
  threadId: string;
  enabled: boolean;
}) {
  const { data, isLoading, isError } = useSdlcLoopStatusQuery({
    threadId,
    enabled,
  });

  if (isLoading) {
    return <SdlcStatusCardSkeleton />;
  }
  if (isError) {
    return null;
  }
  if (!data) {
    return null;
  }

  const updatedAtLabel = new Date(data.updatedAtIso).toLocaleString();

  return (
    <Card className="py-3 gap-3">
      <CardHeader className="px-4 pb-0 gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm">SDLC Loop</CardTitle>
            <CardDescription className="text-xs mt-1">
              {data.stateLabel}
            </CardDescription>
          </div>
          <Badge
            variant={
              data.needsAttention.isBlocked ? "destructive" : "secondary"
            }
          >
            {data.needsAttention.isBlocked ? "Needs Attention" : "On Track"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{data.explanation}</p>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Progress</span>
            <span>{data.progressPercent}%</span>
          </div>
          <Progress value={data.progressPercent} className="h-1.5" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Last updated {updatedAtLabel}
        </p>
      </CardHeader>

      <CardContent className="px-4 pt-0 space-y-3">
        <Separator />
        <section aria-label="SDLC checks" className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Checks
          </p>
          <div className="space-y-2">
            {data.checks.map((check) => (
              <div key={check.key} className="rounded-md border px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">{check.label}</p>
                  <Badge
                    variant={getCheckBadgeVariant(check.status)}
                    className={cn(
                      "text-[10px] px-2 py-0",
                      getCheckBadgeClassName(check.status),
                    )}
                  >
                    {getCheckStatusLabel(check.status)}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {check.detail}
                </p>
              </div>
            ))}
          </div>
        </section>

        {data.needsAttention.isBlocked && (
          <>
            <Separator />
            <section aria-label="Needs attention" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Needs Attention
                </p>
                <Badge variant="destructive" className="text-[10px] px-2 py-0">
                  {data.needsAttention.blockerCount} blocker
                  {data.needsAttention.blockerCount === 1 ? "" : "s"}
                </Badge>
              </div>
              {data.needsAttention.topBlockers.length > 0 && (
                <ul className="space-y-1">
                  {data.needsAttention.topBlockers.map((blocker) => (
                    <li
                      key={`${blocker.source}:${blocker.title}`}
                      className="text-xs text-muted-foreground"
                    >
                      {blocker.title}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <Separator />
        <section aria-label="SDLC links" className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Links
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <ExternalStatusLink
              label="Pull Request"
              href={data.links.pullRequestUrl}
            />
            <ExternalStatusLink
              label="Status Comment"
              href={data.links.statusCommentUrl}
            />
            <ExternalStatusLink
              label="Check Run"
              href={data.links.checkRunUrl}
            />
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

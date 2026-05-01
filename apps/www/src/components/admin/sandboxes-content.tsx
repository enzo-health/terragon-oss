"use client";

import { Card, CardContent } from "@/components/ui/card";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { ThreadWithUser, AdminThreadsTable } from "./threads-list";

export function SandboxesContent({
  count,
  activeThreads,
}: {
  count: number;
  activeThreads: ThreadWithUser[];
}) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Active Sandboxes" },
  ]);
  const utilization = Math.min(100, Math.round((count / 100) * 100));
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-col gap-3 py-6">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              Active sandboxes
            </span>
            <span className="font-mono text-sm tabular-nums text-muted-foreground">
              {utilization}%
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums tracking-tight">
              {count}
            </span>
            <span className="text-sm tabular-nums text-muted-foreground">
              / 100
            </span>
          </div>
          <div className="h-[2px] w-full overflow-hidden rounded-full bg-sunken">
            <div
              className="h-full rounded-full bg-coral"
              style={{ width: `${utilization}%` }}
            />
          </div>
        </CardContent>
      </Card>
      <AdminThreadsTable threads={activeThreads} />
    </div>
  );
}

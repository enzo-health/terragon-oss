"use client";

import Link from "next/link";
import { DataTable } from "@/components/ui/data-table";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { Pill } from "@/components/shared/pill";
import { format } from "date-fns";
import { Automation } from "@terragon/shared/db/types";
import {
  triggerTypeLabels,
  AutomationTriggerType,
} from "@terragon/shared/automations";
import { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";

interface AutomationWithUser extends Automation {
  user: {
    id: string;
    name: string;
    email: string;
  } | null;
}

const columns: ColumnDef<AutomationWithUser>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => {
      const automation = row.original;
      return (
        <Link
          href={`/internal/admin/automations/${automation.id}`}
          className="font-medium underline"
        >
          {automation.name}
        </Link>
      );
    },
  },
  {
    accessorKey: "user.name",
    header: "User",
    cell: ({ row }) => {
      const user = row.original.user;
      return user ? (
        <Link href={`/internal/admin/user/${user.id}`} className="underline">
          {user.name}
        </Link>
      ) : (
        "Unknown"
      );
    },
  },
  {
    accessorKey: "triggerType",
    header: "Type",
    cell: ({ row }) => {
      const triggerType = row.getValue<string>("triggerType");
      return (
        <Pill label={triggerTypeLabels[triggerType as AutomationTriggerType]} />
      );
    },
  },
  {
    accessorKey: "enabled",
    header: "Status",
    cell: ({ row }) => {
      const enabled = row.getValue<boolean>("enabled");
      return (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
            enabled
              ? "bg-success/10 text-success"
              : "bg-muted text-muted-foreground",
          )}
        >
          {enabled ? "Enabled" : "Disabled"}
        </span>
      );
    },
  },
  {
    accessorKey: "runCount",
    header: "Run Count",
    cell: ({ row }) => (
      <span className="font-mono tabular-nums">
        {row.getValue<number>("runCount")}
      </span>
    ),
  },
  {
    accessorKey: "lastRunAt",
    header: "Last Run",
    cell: ({ row }) => {
      const lastRunAt = row.getValue<Date | null>("lastRunAt");
      return (
        <span className="tabular-nums">
          {lastRunAt ? format(lastRunAt, "MMM d, yyyy h:mm a") : "Never"}
        </span>
      );
    },
  },
  {
    accessorKey: "createdAt",
    header: "Created At",
    cell: ({ row }) => {
      return (
        <span className="tabular-nums">
          {format(row.getValue<Date>("createdAt"), "MMM d, yyyy h:mm a")}
        </span>
      );
    },
  },
];

export function AdminAutomationsList({
  automations,
  triggerType,
}: {
  automations: AutomationWithUser[];
  triggerType?: AutomationTriggerType;
}) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Automations" },
  ]);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          Filter
        </span>
        <div className="flex flex-wrap gap-1.5">
          <AdminAutomationsListFilterButton
            triggerType={undefined}
            currentTriggerType={triggerType}
          />
          {Object.entries(triggerTypeLabels).map(([type]) => (
            <AdminAutomationsListFilterButton
              key={type}
              triggerType={type as AutomationTriggerType}
              currentTriggerType={triggerType}
            />
          ))}
        </div>
      </div>
      <AdminAutomationsTable automations={automations} />
    </div>
  );
}

export function AdminAutomationsTable({
  automations,
}: {
  automations: AutomationWithUser[];
}) {
  return <DataTable columns={columns} data={automations} />;
}

function AdminAutomationsListFilterButton({
  triggerType,
  currentTriggerType,
}: {
  triggerType?: AutomationTriggerType;
  currentTriggerType?: AutomationTriggerType;
}) {
  const router = useRouter();
  const isActive = triggerType === currentTriggerType;
  const label = triggerType ? triggerTypeLabels[triggerType] : "All";
  return (
    <button
      type="button"
      onClick={() => {
        if (triggerType) {
          router.push(`/internal/admin/automations?triggerType=${triggerType}`);
        } else {
          router.push(`/internal/admin/automations`);
        }
      }}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/50",
        isActive
          ? "border-foreground/20 bg-foreground/5 font-medium text-foreground"
          : "border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

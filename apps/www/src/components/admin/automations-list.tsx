"use client";

import Link from "next/link";
import { DataTable } from "@/components/ui/data-table";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { Pill } from "@/components/shared/pill";
import { format } from "date-fns";
import { Automation } from "@leo/shared/db/types";
import {
  triggerTypeLabels,
  AutomationTriggerType,
} from "@leo/shared/automations";
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
        <Pill
          label={enabled ? "Enabled" : "Disabled"}
          className={enabled ? "" : "opacity-60"}
        />
      );
    },
  },
  {
    accessorKey: "runCount",
    header: "Run Count",
  },
  {
    accessorKey: "lastRunAt",
    header: "Last Run",
    cell: ({ row }) => {
      const lastRunAt = row.getValue<Date | null>("lastRunAt");
      return lastRunAt ? format(lastRunAt, "MMM d, yyyy h:mm a") : "Never";
    },
  },
  {
    accessorKey: "createdAt",
    header: "Created At",
    cell: ({ row }) => {
      return format(row.getValue<Date>("createdAt"), "MMM d, yyyy h:mm a");
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
      <div className="flex gap-2 items-center text-sm">
        <p className="text-muted-foreground">Filter by type:</p>
        <div className="flex gap-2">
          <AdminAutomationsListFilterButton
            triggerType={undefined}
            currentTriggerType={triggerType}
          />
          {Object.entries(triggerTypeLabels).map(([type, label]) => (
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
    <a
      onClick={() => {
        if (triggerType) {
          router.push(`/internal/admin/automations?triggerType=${triggerType}`);
        } else {
          router.push(`/internal/admin/automations`);
        }
      }}
      className={cn(
        "border px-2 py-1 rounded-md opacity-50 cursor-pointer",
        isActive && "font-medium opacity-100",
      )}
    >
      {label}
    </a>
  );
}

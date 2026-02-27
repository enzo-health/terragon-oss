"use client";

import { format } from "date-fns";
import Link from "next/link";
import { DataTable } from "@/components/ui/data-table";
import { ColumnDef } from "@tanstack/react-table";
import { User } from "@terragon/shared";
import { BILLABLE_EVENT_TYPES } from "@terragon/shared/model/credits";
import { UserForAdminPage } from "@/server-lib/admin";

type TopCreditsUser = UserForAdminPage<
  User & {
    totalCents: number;
    eventTypes: (typeof BILLABLE_EVENT_TYPES)[number][];
  }
>;

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function formatUsdFromCents(valueInCents: number) {
  return currencyFormatter.format(valueInCents / 100);
}

const topUsersColumns: ColumnDef<TopCreditsUser>[] = [
  {
    accessorKey: "rank",
    header: "#",
    cell: ({ row }) => (
      <div className="text-muted-foreground font-mono w-5">{row.index + 1}</div>
    ),
    enableSorting: false,
  },
  {
    accessorKey: "name",
    header: "User",
    cell: ({ row }) => (
      <Link
        href={`/internal/admin/user/${row.original.id}`}
        className="underline"
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: "totalCents",
    header: "Total Spend",
    cell: ({ row }) => (
      <div className="text-sm font-medium">
        {formatUsdFromCents(row.original.totalCents)}
      </div>
    ),
  },
  {
    accessorKey: "eventTypes",
    header: "Providers",
    cell: ({ row }) => {
      const providerLabels: Partial<
        Record<(typeof BILLABLE_EVENT_TYPES)[number], string>
      > = {
        billable_openai_usd: "OpenAI",
        billable_anthropic_usd: "Anthropic",
        billable_openrouter_usd: "OpenRouter",
        billable_google_usd: "Google",
      };
      const labels = row.original.eventTypes
        .map((eventType) => providerLabels[eventType] ?? eventType)
        .sort();
      return (
        <div className="text-sm text-muted-foreground">{labels.join(", ")}</div>
      );
    },
  },
  {
    accessorKey: "mostRecentThreadDate",
    header: "Most Recent Thread",
    cell: ({ row }) => {
      const date = row.getValue("mostRecentThreadDate") as Date | null;
      return date ? format(date, "MMM d, yyyy h:mm a zzz") : "No threads";
    },
  },
  {
    accessorKey: "numThreads",
    header: "Total Threads (All Time)",
  },
  {
    accessorKey: "threadsCreatedPastDay",
    header: "Total Threads (Last Day)",
  },
  {
    accessorKey: "threadsCreatedPastWeek",
    header: "Total Threads (Last Week)",
  },
];

export function TopUsersTable({ data }: { data: TopCreditsUser[] }) {
  return <DataTable columns={topUsersColumns} data={data} />;
}

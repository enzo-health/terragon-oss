"use client";

import { DataTable } from "@/components/ui/data-table";
import { ColumnDef } from "@tanstack/react-table";
import { UserWithSharedRepos } from "./page";
import Link from "next/link";
import { format } from "date-fns";
import { formatUsdFromCents } from "@/lib/currency";

const columns: ColumnDef<UserWithSharedRepos>[] = [
  {
    accessorKey: "name",
    header: "User",
    cell: ({ row }) => (
      <Link
        href={`/internal/admin/user/${row.original.id}`}
        className="underline hover:text-foreground"
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: "sharedRepoCount",
    header: "Shared Repos",
    cell: ({ row }) => (
      <div className="text-sm font-medium">{row.original.sharedRepoCount}</div>
    ),
  },
  {
    accessorKey: "sharedRepos",
    header: "Repositories",
    cell: ({ row }) => {
      const sortedRepos = [...row.original.sharedRepos].sort();
      return (
        <div className="flex flex-col gap-1 text-xs">
          {sortedRepos.map((repo) => (
            <a
              key={repo}
              href={`https://github.com/${repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:underline"
            >
              {repo}
            </a>
          ))}
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const reposA = rowA.original.sharedRepos.join(",");
      const reposB = rowB.original.sharedRepos.join(",");
      return reposA.localeCompare(reposB);
    },
  },
  {
    accessorKey: "numThreads",
    header: "Total Threads",
    cell: ({ row }) => <div className="text-sm">{row.original.numThreads}</div>,
  },
  {
    accessorKey: "totalCreditsCents",
    header: "Total Credits Used",
    cell: ({ row }) => (
      <div className="text-sm">
        {formatUsdFromCents(row.original.totalCreditsCents)}
      </div>
    ),
  },
  {
    accessorKey: "threadsCreatedPastWeek",
    header: "Threads (7d)",
    cell: ({ row }) => (
      <div className="text-sm">{row.original.threadsCreatedPastWeek}</div>
    ),
  },
  {
    accessorKey: "mostRecentThreadDate",
    header: "Most Recent Thread",
    cell: ({ row }) => {
      const date = row.original.mostRecentThreadDate;
      return date ? format(date, "PPP p") : "-";
    },
  },
  {
    accessorKey: "email",
    header: "Email",
    cell: ({ row }) => (
      <div className="text-sm text-muted-foreground">{row.original.email}</div>
    ),
  },
];

export function AbuseDetectionTable({ data }: { data: UserWithSharedRepos[] }) {
  return <DataTable columns={columns} data={data} />;
}

"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { DataTable } from "@/components/ui/data-table";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { AdminThreadIdInput } from "@/components/admin/thread-content";
import { format } from "date-fns";
import { PRStatusPill } from "@/components/pr-status-pill";
import { ThreadInfo } from "@leo/shared";
import { ColumnDef } from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { useCallback } from "react";
import { ThreadStatusIndicator } from "../thread-status";
import { ThreadAgentIcon } from "../thread-agent-icon";

export interface ThreadWithUser {
  thread: ThreadInfo;
  user: {
    id: string;
    name: string;
    email: string;
  } | null;
}

const columns: ColumnDef<ThreadWithUser>[] = [
  {
    accessorKey: "thread.name",
    header: "Thread Name",
    cell: ({ row }) => {
      const t = row.original.thread;
      return (
        <Link
          href={`/internal/admin/thread/${t.id}`}
          className="font-medium underline block max-w-[500px] truncate"
        >
          {t.name || "Untitled Thread"}
        </Link>
      );
    },
  },
  {
    accessorKey: "user.name",
    header: "User",
    cell: ({ row }) => {
      const u = row.original.user;
      return u ? (
        <Link href={`/internal/admin/user/${u.id}`} className="underline">
          {u.name}
        </Link>
      ) : (
        "Unknown"
      );
    },
  },
  {
    accessorKey: "thread.status",
    header: "Status",
    cell: ({ row }) => {
      const thread = row.original.thread;
      return (
        <div className="flex items-center gap-2">
          <ThreadStatusIndicator thread={{ ...thread, isUnread: false }} />
          {row.original.thread.threadChats
            .map((chat) => chat.status)
            .join(", ")}
        </div>
      );
    },
  },
  {
    accessorKey: "thread.githubRepoFullName",
    header: "Repository",
    cell: ({ row }) => row.original.thread.githubRepoFullName,
  },
  {
    accessorKey: "thread.agent",
    header: "Agent",
    cell: ({ row }) => {
      const thread = row.original.thread;
      return <ThreadAgentIcon thread={thread} />;
    },
  },
  {
    accessorKey: "thread.sandboxProvider",
    header: "Sandbox Provider",
    cell: ({ row }) => row.original.thread.sandboxProvider,
  },
  {
    accessorKey: "thread.createdAt",
    header: "Created At",
    cell: ({ row }) => {
      return format(row.original.thread.createdAt, "MMM d, yyyy h:mm a zzz");
    },
  },
  {
    id: "prStatus",
    header: "PR Status",
    cell: ({ row }) => {
      const t = row.original.thread;
      return t.githubPRNumber && t.prStatus ? (
        <PRStatusPill
          status={t.prStatus}
          checksStatus={t.prChecksStatus}
          prNumber={t.githubPRNumber}
          repoFullName={t.githubRepoFullName}
        />
      ) : (
        <span>No PR</span>
      );
    },
  },
  {
    id: "thread.errorMessage",
    header: "Error Message",
    cell: ({ row }) => {
      return row.original.thread.threadChats
        .map((chat) => chat.errorMessage)
        .filter(Boolean)
        .join(", ");
    },
  },
];

type ThreadsListFilter = {
  status?: string[];
  agent?: string;
  limit?: number;
  errorMessage?: boolean;
  sourceType?: string;
};

function AdminThreadsListFilter({ where }: { where: ThreadsListFilter }) {
  const keys = Object.keys(where);
  if (keys.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col text-sm gap-1">
      <span className="font-bold">Showing threads where:</span>
      <div className="flex flex-col">
        {keys.map((key) => (
          <span key={key}>
            {key} = {JSON.stringify(where[key as keyof ThreadsListFilter])}
          </span>
        ))}
      </div>
      {keys.length > 1 && (
        <Link href={`/internal/admin/thread`} className="underline">
          Reset filters
        </Link>
      )}
    </div>
  );
}

type ThreadCounts = {
  total: number;
  byStatus: Record<string, number>;
  byErrorMessage: Record<string, number>;
  byAgent: Record<string, number>;
  bySource: Record<string, number>;
};

function AdminThreadsListCounts({ counts }: { counts: ThreadCounts }) {
  const router = useRouter();
  const filterByStatus = useCallback(
    (status: string) => {
      router.push(`/internal/admin/thread?status=${status}`);
    },
    [router],
  );
  const filterByAgent = useCallback(
    (agent: string) => {
      router.push(`/internal/admin/thread?agent=${agent}`);
    },
    [router],
  );
  // Sort by counts
  const sortedStatusKeys = Object.keys(counts.byStatus).sort((a, b) => {
    return (counts.byStatus[b] ?? 0) - (counts.byStatus[a] ?? 0);
  });
  const sortedErrorMessageKeys = Object.keys(counts.byErrorMessage).sort(
    (a, b) => {
      return (counts.byErrorMessage[b] ?? 0) - (counts.byErrorMessage[a] ?? 0);
    },
  );
  const sortedAgentKeys = Object.keys(counts.byAgent).sort((a, b) => {
    return (counts.byAgent[b] ?? 0) - (counts.byAgent[a] ?? 0);
  });
  const sortedSourceKeys = Object.keys(counts.bySource).sort((a, b) => {
    return (counts.bySource[b] ?? 0) - (counts.bySource[a] ?? 0);
  });
  return (
    <div className="flex flex-col text-sm gap-2">
      <div className="flex flex-col gap-1">
        <span className="font-bold">
          Total threads (Past week): {counts.total}
        </span>
        <div className="rounded-md border w-fit">
          <Table className="w-fit">
            <TableHeader>
              <TableRow>
                {sortedStatusKeys.map((key) => (
                  <TableHead className="!w-[50px]" key={key}>
                    <button
                      className="underline cursor-pointer"
                      onClick={() => filterByStatus(key)}
                    >
                      {key}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                {sortedStatusKeys.map((key) => (
                  <TableCell className="!w-[50px]" key={key}>
                    {counts.byStatus[key]}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="font-bold">By agent (Past week):</span>
        <div className="rounded-md border w-fit">
          <Table className="w-fit">
            <TableHeader>
              <TableRow>
                {sortedAgentKeys.map((key) => (
                  <TableHead className="!w-[50px]" key={key}>
                    <button
                      className="underline cursor-pointer"
                      onClick={() => filterByAgent(key)}
                    >
                      {key}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                {sortedAgentKeys.map((key) => (
                  <TableCell className="!w-[50px]" key={key}>
                    {counts.byAgent[key]}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Link
          href="/internal/admin/thread?error=true"
          className="font-bold underline"
        >
          Threads with errors (Past week):
        </Link>
        {counts.byErrorMessage.total && counts.byErrorMessage.total > 0 ? (
          <div className="rounded-md border w-fit">
            <Table className="w-fit">
              <TableHeader>
                <TableRow>
                  {sortedErrorMessageKeys.map((key) => (
                    <TableHead className="!w-[50px]" key={key}>
                      {key}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  {sortedErrorMessageKeys.map((key) => (
                    <TableCell className="!w-[50px]" key={key}>
                      {counts.byErrorMessage[key]}
                    </TableCell>
                  ))}
                </TableRow>
              </TableBody>
            </Table>
          </div>
        ) : (
          <span>No threads with errors</span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="font-bold">By source (Past week):</span>
        <div className="rounded-md border w-fit">
          <Table className="w-fit">
            <TableHeader>
              <TableRow>
                {sortedSourceKeys.map((key) => (
                  <TableHead className="!w-[50px]" key={key}>
                    <Link
                      href={`/internal/admin/thread?source=${key}`}
                      className="underline"
                    >
                      {key}
                    </Link>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                {sortedSourceKeys.map((key) => (
                  <TableCell className="!w-[50px]" key={key}>
                    {counts.bySource[key]}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

export function AdminThreadsList({
  threads,
  counts,
  where,
}: {
  threads: ThreadWithUser[];
  counts: ThreadCounts;
  where: ThreadsListFilter;
}) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Threads" },
  ]);

  return (
    <div className="space-y-6">
      <AdminThreadIdInput />
      <AdminThreadsListCounts counts={counts} />
      <AdminThreadsListFilter where={where} />
      <AdminThreadsTable threads={threads} />
    </div>
  );
}

export function AdminThreadsTable({ threads }: { threads: ThreadWithUser[] }) {
  return <DataTable columns={columns} data={threads} />;
}

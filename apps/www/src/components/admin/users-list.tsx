"use client";

import Link from "next/link";
import { DataTable } from "@/components/ui/data-table";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { useAtomValue } from "jotai";
import { userAtom } from "@/atoms/user";
import { format } from "date-fns";
import { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { exportAllUsersCsv } from "@/server-actions/admin/user";
import {
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  LabelList,
} from "recharts";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { UserSearch } from "./user-search";
import { useRouter } from "next/navigation";
import { UserForAdminPage } from "@/server-lib/admin";

export function AdminUsersList({
  totalUsers,
  totalUsersWithThreads,
  totalUsersWithOnboarding,
  weeklyActiveUsers,
  dailyActiveUsers,
  monthlyActiveUsers,
  signupsLast24Hours,
  signupsLast7Days,
  activeSignupsLast24Hours,
  activeSignupsLast7Days,
  totalPreviewOptIn,
  weeklyActiveUsersByAge,
  userRetentionByAge,
  monthlyActiveUsersByAge,
  monthlyUserRetentionByAge,
  users,
}: {
  totalUsers: number;
  totalUsersWithThreads: number;
  totalUsersWithOnboarding: number;
  weeklyActiveUsers: number;
  dailyActiveUsers: number;
  monthlyActiveUsers: number;
  signupsLast24Hours: number;
  signupsLast7Days: number;
  activeSignupsLast24Hours: number;
  activeSignupsLast7Days: number;
  totalPreviewOptIn: number;
  weeklyActiveUsersByAge: {
    weeksAgo: number;
    totalUsers: number;
    activeUsers: number;
  }[];
  userRetentionByAge: { weeksAgo: number; count: number }[];
  monthlyActiveUsersByAge: {
    monthsAgo: number;
    totalUsers: number;
    activeUsers: number;
  }[];
  monthlyUserRetentionByAge: { monthsAgo: number; count: number }[];
  users: UserForAdminPage[];
}) {
  const user = useAtomValue(userAtom);
  const router = useRouter();

  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Users" },
  ]);

  const exportToCSV = () => {
    const headers = [
      "Name",
      "Email",
      "User ID",
      "Created At",
      "Onboarding Completed",
      "Most Recent Thread",
      "Total Threads (All Time)",
      "Total Threads (Last Day)",
      "Total Threads (Last Week)",
      "Role",
      "Banned",
    ];

    const rows = users.map((u) => [
      u.name || "",
      u.email || "",
      u.id,
      format(u.createdAt, "yyyy-MM-dd HH:mm:ss"),
      u.onboardingCompleted ? "Yes" : "No",
      u.mostRecentThreadDate
        ? format(u.mostRecentThreadDate, "yyyy-MM-dd HH:mm:ss")
        : "No threads",
      u.numThreads.toString(),
      u.threadsCreatedPastDay.toString(),
      u.threadsCreatedPastWeek.toString(),
      u.role || "",
      u.banned ? "Yes" : "No",
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) =>
        row.map((cell) => `"${cell.toString().replace(/"/g, '""')}"`).join(","),
      ),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute(
      "download",
      `terragon-users-${format(new Date(), "yyyy-MM-dd-HHmmss")}.csv`,
    );
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportLoopsCSV = async () => {
    // Server action returns a CSV string with the Loops format
    const csv = await exportAllUsersCsv({ group: "users" });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute(
      "download",
      `terragon-users-loops-${format(new Date(), "yyyy-MM-dd-HHmmss")}.csv`,
    );
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const columns: ColumnDef<UserForAdminPage>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => {
        const u = row.original;
        return (
          <div className="font-medium flex flex-row gap-2 items-center">
            <Link href={`/internal/admin/user/${u.id}`} className="underline">
              {u.name}
            </Link>
            {u.id === user?.id && (
              <span className="px-2 py-0.5 text-[11px] bg-coral/10 text-coral rounded-full">
                You
              </span>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "email",
      header: "Email",
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.getValue("email")}</span>
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Created At",
      cell: ({ row }) => (
        <span className="tabular-nums text-xs">
          {format(row.getValue("createdAt"), "MMM d, yyyy h:mm a zzz")}
        </span>
      ),
    },
    {
      accessorKey: "onboardingCompleted",
      header: "Onboarding Completed",
      cell: ({ row }) => {
        return row.getValue("onboardingCompleted") ? "Yes" : "No";
      },
    },
    {
      accessorKey: "mostRecentThreadDate",
      header: "Most Recent Thread",
      cell: ({ row }) => {
        const date = row.getValue("mostRecentThreadDate") as Date | null;
        return (
          <span className="tabular-nums text-xs">
            {date ? format(date, "MMM d, yyyy h:mm a zzz") : "No threads"}
          </span>
        );
      },
    },
    {
      accessorKey: "numThreads",
      header: "Total Threads (All Time)",
      cell: ({ row }) => (
        <span className="tabular-nums">{row.getValue("numThreads")}</span>
      ),
    },
    {
      accessorKey: "threadsCreatedPastDay",
      header: "Total Threads (Last Day)",
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.getValue("threadsCreatedPastDay")}
        </span>
      ),
    },
    {
      accessorKey: "threadsCreatedPastWeek",
      header: "Total Threads (Last Week)",
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.getValue("threadsCreatedPastWeek")}
        </span>
      ),
    },
    {
      accessorKey: "role",
      header: "Role",
      cell: ({ row }) => {
        const u = row.original;
        return (
          <div className="flex gap-2">
            {u.role && (
              <span className="text-[11px] bg-info/10 text-info-strong px-2.5 py-0.5 rounded-full">
                {u.role}
              </span>
            )}
            {u.banned && (
              <span className="text-[11px] bg-error/10 text-error-strong px-2.5 py-0.5 rounded-full">
                Banned
              </span>
            )}
            {u.shadowBanned && (
              <span className="text-[11px] bg-warning/10 text-warning-strong px-2.5 py-0.5 rounded-full">
                Shadow Ban
              </span>
            )}
          </div>
        );
      },
    },
  ];

  const formatWeekLabel = (weeksAgo: number) => {
    if (weeksAgo === 0) return "This week";
    if (weeksAgo === 1) return "1 week";
    return `${weeksAgo} weeks`;
  };

  const formatMonthLabel = (monthsAgo: number) => {
    if (monthsAgo === 0) return "This month";
    if (monthsAgo === 1) return "1 month";
    return `${monthsAgo} months`;
  };

  const retentionChartConfig = {
    activeUsers: {
      label: "Active Users",
      color: "var(--success)",
    },
    inactiveUsers: {
      label: "Inactive Users",
      color: "var(--divider)",
    },
  } satisfies ChartConfig;

  const retentionChartData =
    weeklyActiveUsersByAge?.map((item) => ({
      week: formatWeekLabel(item.weeksAgo),
      activeUsers: item.activeUsers,
      inactiveUsers: item.totalUsers - item.activeUsers,
      total: item.totalUsers,
    })) || [];

  const activeUsersChartConfig = {
    count: {
      label: "Active Users",
      color: "var(--info)",
    },
  } satisfies ChartConfig;

  const activeUsersChartData =
    userRetentionByAge?.map((item) => ({
      week: formatWeekLabel(item.weeksAgo),
      count: item.count,
    })) || [];

  const monthlyRetentionChartConfig = {
    activeUsers: {
      label: "Active Users",
      color: "var(--success)",
    },
    inactiveUsers: {
      label: "Inactive Users",
      color: "var(--divider)",
    },
  } satisfies ChartConfig;

  const monthlyRetentionChartData =
    monthlyActiveUsersByAge?.map((item) => ({
      month: formatMonthLabel(item.monthsAgo),
      activeUsers: item.activeUsers,
      inactiveUsers: item.totalUsers - item.activeUsers,
      total: item.totalUsers,
    })) || [];

  const monthlyActiveUsersChartConfig = {
    count: {
      label: "Active Users",
      color: "var(--coral)",
    },
  } satisfies ChartConfig;

  const monthlyActiveUsersChartData =
    monthlyUserRetentionByAge?.map((item) => ({
      month: formatMonthLabel(item.monthsAgo),
      count: item.count,
    })) || [];

  return (
    <div className="space-y-6">
      <dl className="grid sm:grid-cols-3 grid-cols-1 gap-x-8 gap-y-4 border-y border-hairline py-4">
        <AdminUserBigNumber
          label="Weekly Active Users"
          value={weeklyActiveUsers}
          description="Users who created at least 1 thread in the last 7 days"
          accent
        />
        <AdminUserBigNumber
          label="Monthly Active Users"
          value={monthlyActiveUsers}
          description="Users who created at least 1 thread in the last 30 days"
        />
        <AdminUserBigNumber
          label="Users active last 24 hours"
          value={dailyActiveUsers}
        />
        <AdminUserBigNumber
          label="New signups active / total (24h)"
          value={`${activeSignupsLast24Hours} / ${signupsLast24Hours}`}
          description="Active / total accounts created in the last 24 hours"
        />
        <AdminUserBigNumber
          label="New signups active / total (7 days)"
          value={`${activeSignupsLast7Days} / ${signupsLast7Days}`}
          description="Active / total accounts created in the last 7 days"
        />
        <AdminUserBigNumber
          label="Users with threads"
          value={totalUsersWithThreads}
        />
        <AdminUserBigNumber
          label="Users completed onboarding"
          value={totalUsersWithOnboarding}
        />
        <AdminUserBigNumber label="All Users" value={totalUsers} />
        <AdminUserBigNumber
          label="Preview features opt-in"
          value={totalPreviewOptIn}
        />
      </dl>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {userRetentionByAge && userRetentionByAge.length > 0 && (
          <div>
            <div className="text-sm font-semibold mb-3">
              Weekly active users by cohort age:
            </div>
            <div className="bg-card rounded-[1.25rem] p-6 shadow-inset-edge">
              <ChartContainer
                config={activeUsersChartConfig}
                className="h-64 w-full"
              >
                <BarChart data={activeUsersChartData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-hairline"
                  />
                  <XAxis
                    dataKey="week"
                    className="text-xs"
                    angle={-45}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis className="text-xs" />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey="count"
                    fill="var(--success)"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ChartContainer>
            </div>
          </div>
        )}
        {weeklyActiveUsersByAge && weeklyActiveUsersByAge.length > 0 && (
          <div>
            <div className="text-sm font-semibold mb-3">
              User retention by cohort age:
            </div>
            <div className="bg-card rounded-[1.25rem] p-6 shadow-inset-edge">
              <ChartContainer
                config={retentionChartConfig}
                className="h-64 w-full"
              >
                <BarChart data={retentionChartData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-hairline"
                  />
                  <XAxis
                    dataKey="week"
                    className="text-xs"
                    angle={-45}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis className="text-xs" />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey="activeUsers"
                    stackId="a"
                    fill="var(--success)"
                  />
                  <Bar
                    dataKey="inactiveUsers"
                    stackId="a"
                    fill="var(--divider)"
                    radius={[4, 4, 0, 0]}
                  >
                    <LabelList
                      position="top"
                      className="fill-foreground"
                      fontSize={10}
                      formatter={(value: any) => {
                        return value;
                      }}
                      content={(props: any) => {
                        const { x, y, width, index } = props;
                        const data = retentionChartData[index];
                        if (!data) return null;
                        return (
                          <text
                            x={x + width / 2}
                            y={y - 4}
                            fill="currentColor"
                            textAnchor="middle"
                            fontSize={10}
                          >
                            {`${data.activeUsers}/${data.total}`}
                          </text>
                        );
                      }}
                    />
                  </Bar>
                </BarChart>
              </ChartContainer>
              <div className="mt-3 flex flex-wrap gap-4 text-xs">
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded"
                    style={{ backgroundColor: "var(--success)" }}
                  />
                  <span>Active in last 7 days</span>
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded"
                    style={{ backgroundColor: "var(--divider)" }}
                  />
                  <span>Not active in last 7 days</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {monthlyUserRetentionByAge && monthlyUserRetentionByAge.length > 0 && (
          <div>
            <div className="text-sm font-semibold mb-3">
              Monthly active users by cohort age:
            </div>
            <div className="bg-card rounded-[1.25rem] p-6 shadow-inset-edge">
              <ChartContainer
                config={monthlyActiveUsersChartConfig}
                className="h-64 w-full"
              >
                <BarChart data={monthlyActiveUsersChartData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-hairline"
                  />
                  <XAxis
                    dataKey="month"
                    className="text-xs"
                    angle={-45}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis className="text-xs" />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey="count"
                    fill="var(--coral)"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ChartContainer>
            </div>
          </div>
        )}
        {monthlyActiveUsersByAge && monthlyActiveUsersByAge.length > 0 && (
          <div>
            <div className="text-sm font-semibold mb-3">
              Monthly user retention by cohort age:
            </div>
            <div className="bg-card rounded-[1.25rem] p-6 shadow-inset-edge">
              <ChartContainer
                config={monthlyRetentionChartConfig}
                className="h-64 w-full"
              >
                <BarChart data={monthlyRetentionChartData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-hairline"
                  />
                  <XAxis
                    dataKey="month"
                    className="text-xs"
                    angle={-45}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis className="text-xs" />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey="activeUsers"
                    stackId="a"
                    fill="var(--success)"
                  />
                  <Bar
                    dataKey="inactiveUsers"
                    stackId="a"
                    fill="var(--divider)"
                    radius={[4, 4, 0, 0]}
                  >
                    <LabelList
                      position="top"
                      className="fill-foreground"
                      fontSize={10}
                      formatter={(value: any) => {
                        return value;
                      }}
                      content={(props: any) => {
                        const { x, y, width, index } = props;
                        const data = monthlyRetentionChartData[index];
                        if (!data) return null;
                        return (
                          <text
                            x={x + width / 2}
                            y={y - 4}
                            fill="currentColor"
                            textAnchor="middle"
                            fontSize={10}
                          >
                            {`${data.activeUsers}/${data.total}`}
                          </text>
                        );
                      }}
                    />
                  </Bar>
                </BarChart>
              </ChartContainer>
              <div className="mt-3 flex flex-wrap gap-4 text-xs">
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded"
                    style={{ backgroundColor: "var(--success)" }}
                  />
                  <span>Active in last 30 days</span>
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded"
                    style={{ backgroundColor: "var(--divider)" }}
                  />
                  <span>Not active in last 30 days</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <UserSearch
        onSelectUser={(user) => {
          router.push(`/internal/admin/user/${user.id}`);
        }}
      />
      <div className="flex justify-end gap-2">
        <Button onClick={exportToCSV} variant="outline" size="sm">
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
        <Button onClick={exportLoopsCSV} variant="outline" size="sm">
          <Download className="h-4 w-4" />
          Export Loops CSV
        </Button>
      </div>
      <DataTable columns={columns} data={users} />
    </div>
  );
}

function AdminUserBigNumber({
  label,
  value,
  description,
  accent,
}: {
  label: string;
  value: number | string;
  description?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-[0.06em] text-mid">{label}</dt>
      <dd
        className={cn(
          "text-2xl font-semibold tabular-nums",
          accent ? "text-coral" : "text-strong",
        )}
      >
        {value}
      </dd>
      {description && (
        <p className="text-xs text-mid leading-snug">{description}</p>
      )}
    </div>
  );
}

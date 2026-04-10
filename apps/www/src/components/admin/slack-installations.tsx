"use client";

import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { format } from "date-fns";
import { ColumnDef } from "@tanstack/react-table";
import { SlackInstallation } from "@leo/shared";

export function AdminSlackInstallations({
  installations,
}: {
  installations: SlackInstallation[];
}) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Slack Installations" },
  ]);

  const columns: ColumnDef<SlackInstallation>[] = [
    {
      accessorKey: "teamName",
      header: "Team Name",
      cell: ({ row }) => {
        const installation = row.original;
        return (
          <div>
            <div className="font-medium">{installation.teamName}</div>
            <div className="text-xs text-muted-foreground">
              {installation.teamId}
            </div>
          </div>
        );
      },
      size: 200,
    },
    {
      accessorKey: "isActive",
      header: "Status",
      cell: ({ row }) => {
        const isActive = row.getValue<boolean>("isActive");
        return (
          <Badge variant={isActive ? "default" : "secondary"}>
            {isActive ? "Active" : "Inactive"}
          </Badge>
        );
      },
      size: 100,
    },
    {
      accessorKey: "isEnterpriseInstall",
      header: "Type",
      cell: ({ row }) => {
        const installation = row.original;
        return (
          <div>
            {installation.isEnterpriseInstall ? (
              <div>
                <Badge variant="secondary">Enterprise</Badge>
                {installation.enterpriseName && (
                  <div className="text-xs text-muted-foreground mt-1">
                    {installation.enterpriseName}
                  </div>
                )}
              </div>
            ) : (
              <Badge>Workspace</Badge>
            )}
          </div>
        );
      },
      size: 150,
    },
    {
      accessorKey: "botUserId",
      header: "Bot User ID",
      cell: ({ row }) => (
        <code className="text-xs bg-muted px-2 py-1 rounded">
          {row.getValue("botUserId")}
        </code>
      ),
      size: 150,
    },
    {
      accessorKey: "scope",
      header: "Scopes",
      cell: ({ row }) => {
        const scopes = (row.getValue("scope") as string).split(",");
        return (
          <div className="flex flex-wrap gap-1">
            {scopes.slice(0, 3).map((scope) => (
              <Badge key={scope} variant="outline" className="text-xs">
                {scope.trim()}
              </Badge>
            ))}
            {scopes.length > 3 && (
              <Badge variant="outline" className="text-xs">
                +{scopes.length - 3} more
              </Badge>
            )}
          </div>
        );
      },
      size: 250,
    },
    {
      accessorKey: "createdAt",
      header: "Installed",
      cell: ({ row }) => {
        return (
          <span className="text-sm text-muted-foreground">
            {format(row.getValue<Date>("createdAt"), "MMM d, yyyy h:mm a zzz")}
          </span>
        );
      },
      size: 180,
    },
  ];

  return (
    <div className="flex flex-col justify-start h-full w-full mx-auto">
      <div className="space-y-4">
        <DataTable columns={columns} data={installations} />
      </div>
    </div>
  );
}

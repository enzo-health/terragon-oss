"use client";

import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import {
  deleteFeatureFlagAction,
  deleteAllUnusedFeatureFlagsAction,
} from "@/server-actions/admin/feature-flag";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { Trash2 } from "lucide-react";
import { FeatureFlag, UserFeatureFlag } from "@leo/shared/db/types";
import Link from "next/link";
import {
  GlobalFeatureFlagToggle,
  UserFeatureFlagToggle,
} from "./feature-flag-toggle";
import { ColumnDef } from "@tanstack/react-table";
import { useAtomValue } from "jotai";
import { userAtom } from "@/atoms/user";

type FeatureFlagWithUserOverride = FeatureFlag & {
  userOverride: boolean | null;
  userResolvedValue: boolean;
};

export function AdminFeatureFlags({
  featureFlags,
  userFeatureFlagOverrides,
  userFeatureFlagValues,
}: {
  featureFlags: FeatureFlag[];
  userFeatureFlagOverrides: UserFeatureFlag[];
  userFeatureFlagValues: Record<string, boolean>;
}) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Feature Flags" },
  ]);
  const user = useAtomValue(userAtom);
  const router = useRouter();

  const userFeatureFlagOverridesMap = new Map(
    userFeatureFlagOverrides.map((f) => [f.featureFlagId, f.value]),
  );
  const featureFlagsWithUserOverride = featureFlags.map((flag) => ({
    ...flag,
    userOverride: userFeatureFlagOverridesMap.get(flag.id) ?? null,
    userResolvedValue: !!userFeatureFlagValues[flag.name],
  }));

  // Separate flags into active (in codebase) and inactive (not in codebase)
  const activeFlags = featureFlagsWithUserOverride.filter(
    (flag) => flag.inCodebase,
  );
  const inactiveFlags = featureFlagsWithUserOverride.filter(
    (flag) => !flag.inCodebase,
  );

  const handleDelete = async (flag: FeatureFlag) => {
    if (
      !confirm(
        `Are you sure you want to delete feature flag "${flag.name}"? This will also remove all user-specific overrides.`,
      )
    ) {
      return;
    }
    try {
      await deleteFeatureFlagAction(flag.id);
      router.refresh();
      toast.success(`Deleted feature flag: ${flag.name}`);
    } catch (error) {
      console.error(error);
      toast.error("Failed to delete feature flag");
    }
  };

  const handleDeleteAllUnused = async () => {
    if (
      !confirm(
        `Are you sure you want to delete ALL ${inactiveFlags.length} unused feature flags? This will also remove all user-specific overrides for these flags.`,
      )
    ) {
      return;
    }
    try {
      const result = await deleteAllUnusedFeatureFlagsAction();
      router.refresh();
      toast.success(`Deleted ${result.deletedCount} unused feature flags`);
    } catch (error) {
      console.error(error);
      toast.error("Failed to delete unused feature flags");
    }
  };

  const columns: ColumnDef<FeatureFlagWithUserOverride>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => {
        const flag = row.original;
        return (
          <Link
            href={`/internal/admin/feature-flags/${flag.name}`}
            className="font-medium underline"
          >
            {flag.name}
          </Link>
        );
      },
    },
    {
      accessorKey: "userResolvedValue",
      header: "Your Value",
      cell: ({ row }) => {
        const flag = row.original;
        return (
          <span className="font-mono">
            {JSON.stringify(userFeatureFlagValues[flag.name])}
          </span>
        );
      },
    },
    {
      accessorKey: "userOverride",
      header: "Your Override",
      cell: ({ row }) => {
        if (!user) {
          return null;
        }
        const flag = row.original;
        return (
          <UserFeatureFlagToggle
            userId={user.id}
            flagName={flag.name}
            value={flag.userOverride}
          />
        );
      },
    },
    {
      id: "globalOverride",
      accessorKey: "globalOverride",
      header: "Global Override",
      cell: ({ row }) => {
        const flag = row.original;
        return (
          <GlobalFeatureFlagToggle
            flagName={flag.name}
            value={flag.globalOverride}
          />
        );
      },
    },
    {
      id: "inEarlyAccess",
      accessorKey: "enabledForPreview",
      header: "In Early Access",
      cell: ({ row }) => {
        const flag = row.original;
        return (
          <span className="font-mono text-sm">
            {flag.enabledForPreview ? "True" : "False"}
          </span>
        );
      },
    },
    // {
    //   accessorKey: "defaultValue",
    //   header: "Default Value",
    //   cell: ({ row }) => (
    //     <span className="font-mono">
    //       {JSON.stringify(row.getValue("defaultValue"))}
    //     </span>
    //   ),
    // },
    {
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground max-w-md truncate">
          {row.getValue("description") || "-"}
        </span>
      ),
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const flag = row.original;
        return (
          <div className="flex items-center gap-2">
            {!flag.inCodebase && (
              <>
                <Button
                  title="Delete flag (Not used in codebase)"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(flag)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col justify-start h-full w-full mx-auto space-y-8">
      <div>
        <h2 className="text-lg font-semibold mb-4">Active Feature Flags</h2>
        <DataTable columns={columns} data={activeFlags} />
      </div>

      {inactiveFlags.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">
              Inactive Feature Flags (Not in Codebase)
            </h2>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteAllUnused}
              className="flex items-center gap-2"
            >
              <Trash2 className="h-4 w-4" />
              Delete All Unused ({inactiveFlags.length})
            </Button>
          </div>
          <DataTable columns={columns} data={inactiveFlags} />
        </div>
      )}
    </div>
  );
}

export function AdminFeatureFlagContent({
  featureFlag,
  userOverrides,
  recentUsers,
}: {
  featureFlag: FeatureFlag;
  userOverrides: {
    user: {
      id: string;
      name: string;
      email: string;
    };
    value: boolean;
  }[];
  recentUsers: {
    id: string;
    name: string;
    email: string;
    createdAt: Date;
  }[];
}) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Feature Flags", href: "/internal/admin/feature-flags" },
    { label: featureFlag.name },
  ]);

  // Get user IDs that have overrides
  const userIdsWithOverrides = new Set(userOverrides.map((o) => o.user.id));
  // Filter out users who already have overrides.
  const additionalUsers = recentUsers.filter(
    (user) => !userIdsWithOverrides.has(user.id),
  );

  const overridesColumns: ColumnDef<(typeof userOverrides)[0]>[] = [
    {
      accessorKey: "user.name",
      header: "User",
      cell: ({ row }) => {
        const user = row.original.user;
        return (
          <Link
            href={`/internal/admin/user/${user.id}`}
            className="font-medium underline"
          >
            {user.name}
          </Link>
        );
      },
    },
    {
      accessorKey: "user.email",
      header: "Email",
    },
    {
      id: "overrideValue",
      header: "Override Value",
      cell: ({ row }) => {
        const override = row.original;
        return (
          <UserFeatureFlagToggle
            userId={override.user.id}
            flagName={featureFlag.name}
            value={override.value}
          />
        );
      },
    },
  ];

  const additionalUsersColumns: ColumnDef<(typeof additionalUsers)[0]>[] = [
    {
      accessorKey: "name",
      header: "User",
      cell: ({ row }) => {
        const user = row.original;
        return (
          <Link
            href={`/internal/admin/user/${user.id}`}
            className="font-medium underline"
          >
            {user.name}
          </Link>
        );
      },
    },
    {
      accessorKey: "email",
      header: "Email",
    },
    {
      id: "override",
      header: "Override",
      cell: ({ row }) => {
        const user = row.original;
        return (
          <UserFeatureFlagToggle
            userId={user.id}
            flagName={featureFlag.name}
            value={null}
          />
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-6 justify-start h-full w-full mx-auto">
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-bold font-mono">{featureFlag.name}</h1>
        <div className="space-y-2 text-sm">
          {featureFlag.description && (
            <div className="flex items-start gap-2">
              <span className="font-medium text-muted-foreground">
                Description:
              </span>
              <span className="text-sm">{featureFlag.description}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="font-medium text-muted-foreground">Default:</span>
            <span className="font-mono text-sm">
              {JSON.stringify(featureFlag.defaultValue)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-muted-foreground">
              Enabled for Preview:
            </span>
            <span className="font-mono text-sm">
              {JSON.stringify(featureFlag.enabledForPreview)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-muted-foreground">
              Global Override:
            </span>
            <span className="font-mono text-sm">
              <GlobalFeatureFlagToggle
                flagName={featureFlag.name}
                value={featureFlag.globalOverride}
              />
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-muted-foreground">
              In Codebase:
            </span>
            <span className="font-mono text-sm">
              {featureFlag.inCodebase ? "Yes" : "No"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-muted-foreground">
              In Early Access:
            </span>
            <span className="font-mono text-sm">
              {featureFlag.enabledForPreview ? "Yes" : "No"}
            </span>
          </div>
        </div>
      </div>
      <div className="space-y-6">
        <div>
          <h2 className="text-sm font-medium mb-3">Users with overrides</h2>
          <DataTable columns={overridesColumns} data={userOverrides} />
        </div>

        {additionalUsers.length > 0 && (
          <div>
            <h2 className="text-sm font-medium mb-3">Other users</h2>
            <DataTable
              columns={additionalUsersColumns}
              data={additionalUsers}
            />
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { SingleEntityTable } from "./single-entity-table";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { ConnectionStatusPill } from "../credentials/connection-status-pill";
import type { AgentProviderCredentialsMap } from "@/server-lib/credentials";
import {
  resetUserOnboarding,
  topUpUserCredits,
  updateUserFlags,
  refreshClaudeCredentials,
  refreshCodexCredentials,
} from "@/server-actions/admin/user";
import {
  User,
  UserFlags,
  ThreadInfo,
  FeatureFlag,
  FeatureFlagName,
  UserFeatureFlag,
  UserSettings,
  Automation,
  SlackAccountWithMetadata,
} from "@terragon/shared";
import { toast } from "sonner";
import { UserSearch } from "./user-search";
import { UserRoleSelector } from "./user-role-selector";
import { UserFlagToggle } from "./user-flag-toggle";
import { UserFeatureFlagToggle } from "./feature-flag-toggle";
import { ImpersonateUserButton } from "./impersonate-user-button";
import { BanUserAction } from "./ban-user-action";
import { ShadowBanUserToggle } from "./shadow-ban-user-toggle";
import { DeleteUserAction } from "./delete-user-action";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCallback, useState, useTransition } from "react";
import { AdminThreadsTable } from "./threads-list";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { XIcon } from "lucide-react";
import { AdminAutomationsTable } from "./automations-list";
import {
  getAllAgentTypes,
  isConnectedCredentialsSupported,
} from "@terragon/agent/utils";
import { DataTable } from "@/components/ui/data-table";
import { ColumnDef } from "@tanstack/react-table";
import { AIAgent } from "@terragon/agent/types";
import { useServerActionMutation } from "@/queries/server-action-helpers";

const userKeys: (keyof User)[] = [
  "id",
  "name",
  "email",
  "role",
  "createdAt",
  "updatedAt",
  "emailVerified",
  "image",
];

const userFlagSkipKeys: (keyof UserFlags)[] = [
  "id",
  "userId",
  "createdAt",
  "updatedAt",
];

const userFlagNullableKeys: (keyof UserFlags)[] = [
  "lastSeenReleaseNotes",
  "lastSeenReleaseNotesVersion",
  "selectedBranch",
  "selectedModel",
  "selectedRepo",
];

type UserBalanceSummary = {
  totalCreditsCents: number;
  totalUsageCents: number;
  balanceCents: number;
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const formatUsd = (valueInCents: number) =>
  currencyFormatter.format(Math.round(valueInCents) / 100);

type FeatureFlagWithResolvedValue = FeatureFlag & {
  userOverride: boolean | null;
  resolvedValue: boolean;
};

export function AdminUserContent({
  user,
  flags,
  agentProviderCredentials,
  recentThreads,
  automations,
  featureFlagsArray,
  featureFlagsResolved,
  userFeatureFlagOverrides,
  userBalance,
  userSettings,
  slackAccounts,
}: {
  user: User;
  flags: UserFlags;
  featureFlagsArray: FeatureFlag[];
  featureFlagsResolved: Record<FeatureFlagName, boolean>;
  userFeatureFlagOverrides: UserFeatureFlag[];
  agentProviderCredentials: AgentProviderCredentialsMap;
  recentThreads?: ThreadInfo[];
  automations: Automation[];
  userBalance: UserBalanceSummary;
  userSettings: UserSettings;
  slackAccounts: SlackAccountWithMetadata[];
}) {
  const router = useRouter();
  const [isTopUpPending, startTopUpTransition] = useTransition();
  const [topUpAmount, setTopUpAmount] = useState("10");
  const balanceLabel = formatUsd(userBalance.balanceCents);
  const totalCreditsLabel = formatUsd(userBalance.totalCreditsCents);
  const totalUsageLabel = formatUsd(userBalance.totalUsageCents);
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Users", href: "/internal/admin/user" },
    { label: user.id },
  ]);
  const userOverridesForFeatureFlag: Record<string, UserFeatureFlag> = {};
  for (const override of userFeatureFlagOverrides) {
    userOverridesForFeatureFlag[override.featureFlagId] = override;
  }
  const searchParams = useSearchParams();
  // Get the current tab from URL, default to "details"
  const currentTab = searchParams.get("tab") || "details";

  // Handle tab change
  const handleTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams);
      params.set("tab", value);
      router.push(`/internal/admin/user/${user.id}?${params.toString()}`);
    },
    [router, searchParams, user.id],
  );

  const handleTopUpCredits = () => {
    const amountInDollars = parseFloat(topUpAmount);
    if (isNaN(amountInDollars) || amountInDollars <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }
    const amountCents = Math.round(amountInDollars * 100);
    startTopUpTransition(() => {
      topUpUserCredits({ userId: user.id, amountCents })
        .then(() => {
          toast.success(`${formatUsd(amountCents)} of credits added to user`);
          router.refresh();
        })
        .catch((error) => {
          console.error(error);
          toast.error("Failed to add credits");
        });
    });
  };

  const refreshClaudeCredentialsMutation = useServerActionMutation({
    mutationFn: refreshClaudeCredentials,
  });
  const refreshCodexCredentialsMutation = useServerActionMutation({
    mutationFn: refreshCodexCredentials,
  });

  const featureFlagsWithResolvedValue: FeatureFlagWithResolvedValue[] =
    featureFlagsArray.map((flag) => ({
      ...flag,
      userOverride: userOverridesForFeatureFlag[flag.id]?.value ?? null,
      resolvedValue: featureFlagsResolved[flag.name as FeatureFlagName],
    }));

  const featureFlagColumns: ColumnDef<FeatureFlagWithResolvedValue>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => {
        const flag = row.original;
        return (
          <Link
            href={`/internal/admin/feature-flags/${flag.name}`}
            className="underline"
          >
            {flag.name}
          </Link>
        );
      },
    },
    {
      accessorKey: "defaultValue",
      header: "Default",
      cell: ({ row }) => {
        const flag = row.original;
        return (
          <span className="font-mono">{JSON.stringify(flag.defaultValue)}</span>
        );
      },
    },
    {
      accessorKey: "globalOverride",
      header: "Global Override",
      cell: ({ row }) => {
        const flag = row.original;
        return (
          <span
            className={cn(
              "font-mono",
              !flag.globalOverride && "text-muted-foreground/50",
            )}
          >
            {JSON.stringify(flag.globalOverride)}
          </span>
        );
      },
    },
    {
      accessorKey: "userOverride",
      header: "User Override",
      cell: ({ row }) => {
        const flag = row.original;
        return (
          <span className="font-mono">
            <UserFeatureFlagToggle
              userId={user.id}
              flagName={flag.name}
              value={flag.userOverride}
            />
          </span>
        );
      },
    },
    {
      accessorKey: "resolvedValue",
      header: "Resolved Value",
      cell: ({ row }) => {
        const flag = row.original;
        return (
          <span className="font-mono">
            {JSON.stringify(flag.resolvedValue)}
          </span>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col justify-start h-full w-full">
      <div className="space-y-6">
        <UserSearch
          onSelectUser={(user) => {
            router.push(`/internal/admin/user/${user.id}`);
          }}
        />
        <Tabs
          value={currentTab}
          onValueChange={handleTabChange}
          className="w-full"
        >
          <TabsList className="">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="feature-flags">Feature Flags</TabsTrigger>
            <TabsTrigger value="user-flags">User Flags</TabsTrigger>
            <TabsTrigger value="user-settings">User Settings</TabsTrigger>
            <TabsTrigger value="actions">Actions</TabsTrigger>
            <TabsTrigger value="threads">Recent Threads</TabsTrigger>
            <TabsTrigger value="automations">Automations</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="mt-4">
            <SingleEntityTable
              entity={user}
              rowKeys={[
                ...userKeys,
                ...getAllAgentTypes()
                  .filter(isConnectedCredentialsSupported)
                  .map((agent) => `agent/${agent}`),
                "slackIntegration",
              ]}
              renderKey={(key) => {
                if (key === "role") {
                  return <UserRoleSelector user={user} />;
                }
                if (key.startsWith("agent/")) {
                  const agent = key.split("/")[1] as AIAgent;
                  const credentials = agentProviderCredentials[agent];
                  const hasCredentials = !!(
                    credentials && credentials.length > 0
                  );
                  return (
                    <div className="flex items-center gap-2">
                      <ConnectionStatusPill connected={hasCredentials} />
                      {hasCredentials && <span>{credentials[0]!.type}</span>}
                    </div>
                  );
                }
                if (key === "slackIntegration") {
                  return slackAccounts.length > 0 ? (
                    <div className="space-y-2">
                      {slackAccounts.map((account) => (
                        <div
                          key={account.id}
                          className="flex items-center gap-2"
                        >
                          <div
                            className={cn(
                              "w-2 h-2 rounded-full",
                              account.installation?.isActive
                                ? "bg-green-500"
                                : "bg-red-500",
                            )}
                          />
                          <span className="text-sm">
                            {account.slackTeamName} ({account.slackTeamDomain})
                            {account.installation?.isActive
                              ? ""
                              : " (Inactive)"}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">
                      No Slack integrations
                    </span>
                  );
                }
              }}
            />
          </TabsContent>
          <TabsContent value="feature-flags" className="mt-4">
            <DataTable
              columns={featureFlagColumns}
              data={featureFlagsWithResolvedValue}
            />
          </TabsContent>
          <TabsContent value="user-flags" className="mt-4">
            <SingleEntityTable
              entity={flags}
              rowKeys={Object.keys(flags).filter(
                (key) => !userFlagSkipKeys.includes(key as keyof UserFlags),
              )}
              renderKey={(key) => {
                const value = flags[key as keyof UserFlags];
                return (
                  <div className="flex items-center gap-2">
                    <div className="w-[80px]">
                      {typeof value === "boolean" ? (
                        <UserFlagToggle
                          userId={user.id}
                          flagName={key}
                          value={value as boolean}
                        />
                      ) : (
                        <pre className="text-xs max-w-[100px] line-clamp-5 overflow-auto">
                          {JSON.stringify(value, null, 2)}
                        </pre>
                      )}
                    </div>
                    <div className="flex items-center justify-center w-[40px] px-0">
                      {userFlagNullableKeys.includes(
                        key as keyof UserFlags,
                      ) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="px-0 size-6"
                          onClick={async () => {
                            try {
                              await updateUserFlags(user.id, {
                                [key]: null,
                              });
                              toast.success("User flag reset");
                              router.refresh();
                            } catch (error) {
                              console.error(error);
                              toast.error("Failed to reset user flag");
                            }
                          }}
                        >
                          <XIcon className="size-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              }}
            />
          </TabsContent>
          <TabsContent value="user-settings" className="mt-4">
            <SingleEntityTable
              entity={userSettings}
              rowKeys={Object.keys(userSettings)}
            />
          </TabsContent>
          <TabsContent value="actions" className="mt-4">
            <Table>
              <TableBody>
                <TableRow>
                  <TableCell className="whitespace-pre-wrap space-y-1">
                    <div>Add platform credits to this user's balance.</div>
                    <div className="text-sm text-muted-foreground">
                      Current balance: {balanceLabel}. Credits issued:{" "}
                      {totalCreditsLabel}. Usage billed: {totalUsageLabel}.
                    </div>
                  </TableCell>
                  <TableCell className="flex flex-col items-start gap-2">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center">
                        <span className="text-sm mr-1">$</span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={topUpAmount}
                          onChange={(e) => setTopUpAmount(e.target.value)}
                          className="w-24"
                          disabled={isTopUpPending}
                        />
                      </div>
                      <Button
                        onClick={handleTopUpCredits}
                        disabled={isTopUpPending}
                      >
                        {isTopUpPending ? "Adding..." : "Add Credits"}
                      </Button>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Enter amount in dollars to add to user's balance.
                    </span>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="whitespace-pre-wrap">
                    Impersonate this user to help debug issues.
                  </TableCell>
                  <TableCell>
                    <ImpersonateUserButton userId={user.id} />
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="whitespace-pre-wrap">
                    Reset the user's onboarding state, disconnects any claude
                    connections.
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="destructive"
                      onClick={async () => {
                        const result = await resetUserOnboarding(user.id);
                        if (result.success) {
                          router.refresh();
                          toast.success("User onboarding reset");
                        } else {
                          toast.error(result.errorMessage);
                        }
                      }}
                    >
                      Reset
                    </Button>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="whitespace-pre-wrap">
                    Ban or unban this user from accessing the application.
                  </TableCell>
                  <TableCell>
                    <BanUserAction user={user} />
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="whitespace-pre-wrap">
                    Shadow ban this user (3 tasks/hour limit).
                  </TableCell>
                  <TableCell>
                    <ShadowBanUserToggle user={user} />
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="whitespace-pre-wrap">
                    Refresh the user's Claude credentials using their refresh
                    token.
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const oauthCreds =
                        agentProviderCredentials.claudeCode?.filter(
                          (cred) => cred.type === "oauth",
                        ) ?? [];
                      return oauthCreds.length > 0 ? (
                        <div className="space-y-2">
                          {oauthCreds.map((cred) => (
                            <div
                              key={cred.id}
                              className="flex items-center gap-2"
                            >
                              <Button
                                variant="outline"
                                onClick={async () => {
                                  await refreshClaudeCredentialsMutation.mutateAsync(
                                    {
                                      userId: user.id,
                                      credentialId: cred.id,
                                    },
                                  );
                                  toast.success("Claude credentials refreshed");
                                  router.refresh();
                                }}
                                disabled={
                                  refreshClaudeCredentialsMutation.isPending
                                }
                              >
                                {refreshClaudeCredentialsMutation.isPending
                                  ? "Refreshing..."
                                  : "Refresh"}
                              </Button>
                              <span className="text-xs text-muted-foreground">
                                {cred.metadata?.type === "claude"
                                  ? cred.metadata.accountEmail
                                  : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">
                          {agentProviderCredentials.claudeCode
                            ? `No OAuth credentials (types: ${agentProviderCredentials.claudeCode.map((c) => c.type).join(", ")})`
                            : "No credentials connected"}
                        </span>
                      );
                    })()}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="whitespace-pre-wrap">
                    Refresh the user's Codex credentials using their refresh
                    token.
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const oauthCreds =
                        agentProviderCredentials.codex?.filter(
                          (cred) => cred.type === "oauth",
                        ) ?? [];
                      return oauthCreds.length > 0 ? (
                        <div className="space-y-2">
                          {oauthCreds.map((cred) => (
                            <div
                              key={cred.id}
                              className="flex items-center gap-2"
                            >
                              <Button
                                variant="outline"
                                onClick={async () => {
                                  await refreshCodexCredentialsMutation.mutateAsync(
                                    {
                                      userId: user.id,
                                      credentialId: cred.id,
                                    },
                                  );
                                  toast.success("Codex credentials refreshed");
                                  router.refresh();
                                }}
                                disabled={
                                  refreshCodexCredentialsMutation.isPending
                                }
                              >
                                {refreshCodexCredentialsMutation.isPending
                                  ? "Refreshing..."
                                  : "Refresh"}
                              </Button>
                              <span className="text-xs text-muted-foreground">
                                {cred.metadata?.type === "openai"
                                  ? cred.metadata.email
                                  : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">
                          {agentProviderCredentials.codex
                            ? `No OAuth credentials (types: ${agentProviderCredentials.codex.map((c) => c.type).join(", ")})`
                            : "No credentials connected"}
                        </span>
                      );
                    })()}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="whitespace-pre-wrap">
                    Permanently delete this user and all associated data. This
                    action cannot be undone.
                  </TableCell>
                  <TableCell>
                    <DeleteUserAction user={user} />
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TabsContent>
          <TabsContent value="threads" className="mt-4">
            {recentThreads ? (
              recentThreads.length === 0 ? (
                <p className="text-muted-foreground">No threads found</p>
              ) : (
                <AdminThreadsTable
                  threads={recentThreads.map((thread) => {
                    return {
                      thread,
                      user,
                    };
                  })}
                />
              )
            ) : (
              <p className="text-muted-foreground">No threads data available</p>
            )}
          </TabsContent>
          <TabsContent value="automations" className="mt-4">
            <AdminAutomationsTable
              automations={automations.map((automation) => {
                return {
                  ...automation,
                  user: user,
                };
              })}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

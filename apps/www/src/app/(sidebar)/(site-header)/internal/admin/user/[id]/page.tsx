import dynamic from "next/dynamic";
import { getUser, getUserSettings } from "@terragon/shared/model/user";
import { getUserFlags } from "@terragon/shared/model/user-flags";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { getAdminUserOrThrow } from "@/lib/auth-server";
import { getThreads } from "@terragon/shared/model/threads";
import { getCachedUserCreditBalance } from "@/server-lib/credit-balance";
import {
  getFeatureFlags,
  getFeatureFlagsForUser,
  getUserFeatureFlagOverrides,
} from "@terragon/shared/model/feature-flags";
import { getAutomations } from "@terragon/shared/model/automations";
import { getAgentProviderCredentials } from "@/server-lib/credentials";
import { getSlackAccounts } from "@terragon/shared/model/slack";
import { Skeleton } from "@/components/ui/skeleton";

// Dynamically import the heavy admin user content component
const AdminUserContent = dynamic(
  () =>
    import("@/components/admin/user-content").then((m) => m.AdminUserContent),
  {
    loading: () => (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    ),
  },
);

export default async function AdminUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await getAdminUserOrThrow();
  const { id } = await params;
  const user = await getUser({ db, userId: id });
  if (!user) {
    notFound();
  }
  const [
    flags,
    agentProviderCredentials,
    recentThreads,
    featureFlagsArray,
    featureFlagsResolved,
    userFeatureFlagOverrides,
    userBalance,
    userSettings,
    automations,
    slackAccounts,
  ] = await Promise.all([
    getUserFlags({ db, userId: id }),
    getAgentProviderCredentials({ userId: id }),
    getThreads({ db, userId: id, limit: 20 }),
    getFeatureFlags({ db }),
    getFeatureFlagsForUser({ db, userId: id }),
    getUserFeatureFlagOverrides({ db, userId: id }),
    getCachedUserCreditBalance(id),
    getUserSettings({ db, userId: id }),
    getAutomations({ db, userId: id }),
    getSlackAccounts({ db, userId: id }),
  ]);
  return (
    <AdminUserContent
      user={user}
      flags={flags}
      featureFlagsArray={featureFlagsArray}
      featureFlagsResolved={featureFlagsResolved}
      userFeatureFlagOverrides={userFeatureFlagOverrides}
      agentProviderCredentials={agentProviderCredentials}
      recentThreads={recentThreads}
      userBalance={userBalance}
      userSettings={userSettings}
      automations={automations}
      slackAccounts={slackAccounts}
    />
  );
}

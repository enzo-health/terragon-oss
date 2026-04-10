import { AdminFeatureFlagContent } from "@/components/admin/feature-flags";
import { FeatureFlagName } from "@leo/shared";
import {
  getFeatureFlag,
  getUserOverridesForFeatureFlag,
} from "@leo/shared/model/feature-flags";
import { getAdminUserOrThrow } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { getRecentUsers } from "@/server-actions/admin/user";

export default async function FeatureFlagPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  await getAdminUserOrThrow();
  const { name } = await params;
  const featureFlag = await getFeatureFlag({
    db,
    name: name as FeatureFlagName,
  });
  if (!featureFlag) {
    notFound();
  }
  const userOverrides = await getUserOverridesForFeatureFlag({
    db,
    flagId: featureFlag.id,
  });
  const recentUsers = await getRecentUsers({ limit: 50 });
  return (
    <AdminFeatureFlagContent
      featureFlag={featureFlag}
      userOverrides={userOverrides}
      recentUsers={recentUsers}
    />
  );
}

import { AdminFeatureFlags } from "@/components/admin/feature-flags";
import {
  getFeatureFlags,
  getFeatureFlagsForUser,
  getUserFeatureFlagOverrides,
} from "@leo/shared/model/feature-flags";
import { getAdminUserOrThrow } from "@/lib/auth-server";
import { db } from "@/lib/db";

export default async function FeatureFlagsPage() {
  const user = await getAdminUserOrThrow();
  const [featureFlags, userFeatureFlagOverrides, userFeatureFlagValues] =
    await Promise.all([
      getFeatureFlags({ db }),
      getUserFeatureFlagOverrides({ db, userId: user.id }),
      getFeatureFlagsForUser({ db, userId: user.id }),
    ]);
  return (
    <AdminFeatureFlags
      featureFlags={featureFlags}
      userFeatureFlagOverrides={userFeatureFlagOverrides}
      userFeatureFlagValues={userFeatureFlagValues}
    />
  );
}

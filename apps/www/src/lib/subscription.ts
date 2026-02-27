import { db } from "@/lib/db";
import type { AccessInfo, BillingInfo } from "@terragon/shared/db/types";
import { getUserIdOrNull } from "./auth-server";
import { getFeatureFlagsGlobal } from "@terragon/shared/model/feature-flags";

/**
 * Returns the access tier for the current user.
 * Internal mode is single-tenant: every authenticated user has full access.
 */
export async function getAccessInfoForUser(
  userId: string,
): Promise<AccessInfo> {
  if (!userId) {
    return { tier: "none" };
  }
  return { tier: "pro" };
}

/** Convenience wrapper for components/actions that want both pieces. */
export async function getBillingInfo(): Promise<BillingInfo> {
  const userId = await getUserIdOrNull();
  if (!userId) {
    throw new Error("Unauthorized");
  }
  return await getBillingInfoForUser({ userId });
}

export async function getBillingInfoForUser({
  userId,
}: {
  userId: string;
}): Promise<BillingInfo> {
  const featureFlags = await getFeatureFlagsGlobal({ db });
  return {
    hasActiveSubscription: true,
    subscription: null,
    signupTrial: null,
    unusedPromotionCode: false,
    isShutdownMode: featureFlags.shutdownMode,
  };
}

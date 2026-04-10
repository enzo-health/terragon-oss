"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  getUserCreditBalance,
  getUserCredits,
} from "@leo/shared/model/credits";

export type UserCreditBreakdown = {
  totalCreditsCents: number;
  totalUsageCents: number;
  balanceCents: number;
  recentGrants: Array<{
    id: string;
    amountCents: number;
    description: string | null;
    referenceId: string | null;
    grantType: string | null;
    createdAt: string;
  }>;
};

export const getUserCreditBreakdownAction = userOnlyAction(
  async function getUserCreditBreakdownAction(
    userId: string,
  ): Promise<UserCreditBreakdown> {
    const [balance, credits] = await Promise.all([
      getUserCreditBalance({
        db,
        userId,
        skipAggCache: false,
      }),
      getUserCredits({ db, userId, limit: 5 }),
    ]);

    return {
      totalCreditsCents: balance.totalCreditsCents,
      totalUsageCents: balance.totalUsageCents,
      balanceCents: balance.balanceCents,
      recentGrants: credits.map((grant) => ({
        id: grant.id,
        amountCents: grant.amountCents,
        description: grant.description,
        referenceId: grant.referenceId,
        grantType: grant.grantType,
        createdAt: grant.createdAt.toISOString(),
      })),
    };
  },
  { defaultErrorMessage: "Failed to get user credit breakdown" },
);

"use server";

import { adminOnly } from "@/lib/auth-server";
import { UserFacingError } from "@/lib/server-actions";

const INTERNAL_TENANT_MESSAGE =
  "Stripe coupon operations are disabled in internal single-tenant mode.";

export type GenerateCouponsResult = {
  created: number;
  skipped: number;
  couponId: string;
  promotionCodes: Array<{
    id: string;
    userId: string;
    email: string;
    code: string;
    stripePromotionCodeId: string;
    stripeCouponId: string;
    createdAt: string;
  }>;
};

export const generateStripeCouponsForUsers = adminOnly(
  async function generateStripeCouponsForUsers(): Promise<GenerateCouponsResult> {
    throw new UserFacingError(INTERNAL_TENANT_MESSAGE);
  },
);

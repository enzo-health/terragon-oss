import Stripe from "stripe";
import { and, eq, inArray, isNull } from "drizzle-orm";

import * as schema from "@leo/shared/db/schema";

import { db } from "./db";

type CheckoutCompletedEvent = {
  event: Stripe.Event;
  stripeClient: Stripe;
};

/**
 * Handles marking promotion codes as redeemed when a checkout session completes.
 */
export async function handlePromotionCodeCheckoutSessionCompleted({
  event,
  stripeClient,
}: CheckoutCompletedEvent): Promise<void> {
  if (event.type !== "checkout.session.completed") {
    return;
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;

  if (!customerId) {
    return;
  }

  const promotionCodeIds = new Set<string>();

  let discounts = Array.isArray(session.discounts) ? session.discounts : null;

  if (!discounts) {
    try {
      const expandedSession = await stripeClient.checkout.sessions.retrieve(
        session.id,
        {
          expand: ["discounts"],
        },
      );
      if (Array.isArray(expandedSession.discounts)) {
        discounts = expandedSession.discounts;
      }
    } catch (error) {
      console.warn(
        "Failed to expand discounts for Stripe checkout session",
        error,
      );
    }
  }

  if (discounts) {
    for (const discount of discounts) {
      const promotionCode =
        typeof discount.promotion_code === "string"
          ? discount.promotion_code
          : discount.promotion_code?.id;
      if (promotionCode) {
        promotionCodeIds.add(promotionCode);
      }
    }
  }

  if (promotionCodeIds.size === 0) {
    return;
  }

  const userRecord = await db.query.user.findFirst({
    columns: { id: true },
    where: eq(schema.user.stripeCustomerId, customerId),
  });

  if (!userRecord?.id) {
    return;
  }

  await db
    .update(schema.userStripePromotionCode)
    .set({ redeemedAt: new Date() })
    .where(
      and(
        eq(schema.userStripePromotionCode.userId, userRecord.id),
        inArray(
          schema.userStripePromotionCode.stripePromotionCodeId,
          Array.from(promotionCodeIds),
        ),
        isNull(schema.userStripePromotionCode.redeemedAt),
      ),
    );
}

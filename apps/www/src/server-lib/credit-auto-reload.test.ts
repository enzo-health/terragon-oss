import { beforeEach, describe, expect, it, MockInstance, vi } from "vitest";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import {
  updateUser,
  updateUserInfoServerSide,
  updateUserSettings,
} from "@terragon/shared/model/user";
import { eq } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import * as stripeConfig from "@/server-lib/stripe";
import { CREDIT_AUTO_RELOAD_REASON } from "./stripe-credit-top-ups";
import { maybeTriggerCreditAutoReload } from "./credit-auto-reload";

async function setupUser({
  stripeCustomerId = "cus_123",
  paymentMethodId = "pm_123",
  autoReloadDisabled = false,
  failureCode = null,
}: {
  stripeCustomerId?: string | null;
  paymentMethodId?: string | null;
  autoReloadDisabled?: boolean;
  failureCode?: string | null;
} = {}) {
  const { user } = await createTestUser({
    db,
    skipBillingFeatureFlag: true,
  });
  const userId = user.id;
  await updateUser({ db, userId, updates: { stripeCustomerId } });
  await updateUserSettings({ db, userId, updates: { autoReloadDisabled } });
  await updateUserInfoServerSide({
    db,
    userId,
    updates: {
      stripeCreditPaymentMethodId: paymentMethodId,
      autoReloadLastFailureCode: failureCode,
      autoReloadLastFailureAt: failureCode ? new Date() : null,
    },
  });
  return { userId };
}

describe("maybeTriggerCreditAutoReload", () => {
  let stripeInvoicesCreateSpy: MockInstance<
    typeof stripeConfig.stripeInvoicesCreate
  >;
  let stripeInvoiceItemsCreateSpy: MockInstance<
    typeof stripeConfig.stripeInvoiceItemsCreate
  >;
  let stripeInvoicesFinalizeSpy: MockInstance<
    typeof stripeConfig.stripeInvoicesFinalizeInvoice
  >;
  let stripeInvoicesPaySpy: MockInstance<typeof stripeConfig.stripeInvoicesPay>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();

    vi.spyOn(stripeConfig, "isStripeConfiguredForCredits").mockReturnValue(
      true,
    );
    vi.spyOn(stripeConfig, "getStripeCreditPackPriceId").mockReturnValue(
      "STRIPE_PRICE_CREDIT_PACK_TEST",
    );

    stripeInvoicesCreateSpy = vi
      .spyOn(stripeConfig, "stripeInvoicesCreate")
      .mockResolvedValue({
        id: "in_test_123",
      } as any);
    stripeInvoiceItemsCreateSpy = vi
      .spyOn(stripeConfig, "stripeInvoiceItemsCreate")
      .mockResolvedValue({} as any);
    stripeInvoicesFinalizeSpy = vi
      .spyOn(stripeConfig, "stripeInvoicesFinalizeInvoice")
      .mockResolvedValue({} as any);
    stripeInvoicesPaySpy = vi
      .spyOn(stripeConfig, "stripeInvoicesPay")
      .mockResolvedValue({} as any);
  });

  it("does nothing when Stripe credits are not configured", async () => {
    const { userId } = await setupUser();
    const configSpy = vi
      .spyOn(stripeConfig, "isStripeConfiguredForCredits")
      .mockReturnValue(false);
    await maybeTriggerCreditAutoReload({ userId, balanceCents: 100 });
    expect(stripeInvoicesCreateSpy).not.toHaveBeenCalled();
    configSpy.mockRestore();
  });

  it("skips when balance is above the threshold", async () => {
    const { userId } = await setupUser();
    await maybeTriggerCreditAutoReload({ userId, balanceCents: 1_000 });
    expect(stripeInvoicesCreateSpy).not.toHaveBeenCalled();
  });

  it("skips when auto reload is disabled in user settings", async () => {
    const { userId } = await setupUser({ autoReloadDisabled: true });
    await maybeTriggerCreditAutoReload({ userId, balanceCents: 50 });
    expect(stripeInvoicesCreateSpy).not.toHaveBeenCalled();
  });

  it("skips when the Stripe customer id is missing", async () => {
    const { userId } = await setupUser({ stripeCustomerId: null });
    await maybeTriggerCreditAutoReload({ userId, balanceCents: 50 });
    expect(stripeInvoicesCreateSpy).not.toHaveBeenCalled();
  });

  it("skips when the stored payment method is missing", async () => {
    const { userId } = await setupUser({ paymentMethodId: null });
    await maybeTriggerCreditAutoReload({ userId, balanceCents: 50 });
    expect(stripeInvoicesCreateSpy).not.toHaveBeenCalled();
  });

  it("skips when the previous failure code requires manual intervention", async () => {
    const { userId } = await setupUser({ failureCode: "card_declined" });
    await maybeTriggerCreditAutoReload({ userId, balanceCents: 50 });
    expect(stripeInvoicesCreateSpy).not.toHaveBeenCalled();
  });

  it("skips when the auto reload lock is already held", async () => {
    const { userId } = await setupUser();
    const lockKey = `credits:auto-reload:${userId}`;
    await redis.set(lockKey, "1");
    await maybeTriggerCreditAutoReload({ userId, balanceCents: 50 });
    expect(stripeInvoicesCreateSpy).not.toHaveBeenCalled();
  });

  it("creates a Stripe invoice flow and clears failure state", async () => {
    const { userId } = await setupUser();
    await maybeTriggerCreditAutoReload({ userId, balanceCents: 50 });
    expect(stripeInvoicesCreateSpy).toHaveBeenCalledWith({
      customer: "cus_123",
      default_payment_method: "pm_123",
      auto_advance: false,
      description: "Terragon Credit Auto-Reload",
      metadata: {
        terragon_user_id: userId,
        reason: CREDIT_AUTO_RELOAD_REASON,
      },
    });
    expect(stripeInvoiceItemsCreateSpy).toHaveBeenCalledWith({
      customer: "cus_123",
      invoice: "in_test_123",
      pricing: {
        price: "STRIPE_PRICE_CREDIT_PACK_TEST",
      },
      description: "Terragon Credit Auto-Reload",
      metadata: {
        terragon_user_id: userId,
        reason: CREDIT_AUTO_RELOAD_REASON,
      },
    });
    expect(stripeInvoicesFinalizeSpy).toHaveBeenCalledWith("in_test_123");
    expect(stripeInvoicesPaySpy).toHaveBeenCalledWith("in_test_123", {
      off_session: true,
    });
    const userInfo = await db.query.userInfoServerSide.findFirst({
      where: eq(schema.userInfoServerSide.userId, userId),
    });
    expect(userInfo?.autoReloadLastAttemptAt).toBeInstanceOf(Date);
    expect(userInfo?.autoReloadLastFailureCode).toBeNull();
    expect(userInfo?.autoReloadLastFailureAt).toBeNull();
  });

  it("records failure details when the Stripe invoice payment fails", async () => {
    const { userId } = await setupUser();
    stripeInvoicesPaySpy.mockRejectedValueOnce(new Error("card_declined"));
    await maybeTriggerCreditAutoReload({ userId, balanceCents: 50 });
    expect(stripeInvoicesCreateSpy).toHaveBeenCalled();
    expect(stripeInvoiceItemsCreateSpy).toHaveBeenCalled();
    expect(stripeInvoicesFinalizeSpy).toHaveBeenCalled();
    expect(stripeInvoicesPaySpy).toHaveBeenCalled();
    const userInfo = await db.query.userInfoServerSide.findFirst({
      where: eq(schema.userInfoServerSide.userId, userId),
    });
    expect(userInfo?.autoReloadLastAttemptAt).toBeInstanceOf(Date);
    expect(userInfo?.autoReloadLastFailureCode).toBe("card_declined");
    expect(userInfo?.autoReloadLastFailureAt).toBeInstanceOf(Date);
  });
});

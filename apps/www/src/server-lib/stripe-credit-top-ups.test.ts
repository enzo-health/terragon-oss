import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { db } from "@/lib/db";
import { createTestUser } from "@leo/shared/model/test-helpers";
import { getUserCredits } from "@leo/shared/model/credits";
import { getUserInfoServerSide } from "@leo/shared/model/user";
import { nanoid } from "nanoid/non-secure";
import {
  CREDIT_AUTO_RELOAD_REASON,
  CREDIT_TOP_UP_REASON,
  handleStripeCreditTopUpEvent,
} from "./stripe-credit-top-ups";

describe("handleStripeCreditTopUpEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("grants credits for invoice.paid events", async () => {
    const { user } = await createTestUser({ db });
    const invoiceId = `in_test_topup_${nanoid()}`;
    const event = {
      id: "evt_test_invoice_paid",
      type: "invoice.paid",
      data: {
        object: {
          id: invoiceId,
          object: "invoice",
          subtotal: 2_000,
          amount_paid: 2_000,
          metadata: {
            leo_user_id: user.id,
            reason: CREDIT_TOP_UP_REASON,
          },
        } as unknown as Stripe.Invoice,
      },
    } as unknown as Stripe.Event;

    await handleStripeCreditTopUpEvent(event);

    const credits = await getUserCredits({
      db,
      userId: user.id,
      referenceId: `stripe_invoice:${invoiceId}`,
      limit: 5,
    });
    expect(credits).toHaveLength(1);
    expect(credits[0]?.amountCents).toBe(2_000);
    expect(credits[0]?.grantType).toBe("stripe_top_up");
  });

  it("accepts legacy terragon_user_id metadata", async () => {
    const { user } = await createTestUser({ db });
    const invoiceId = `in_test_topup_legacy_${nanoid()}`;
    const event = {
      id: "evt_test_invoice_paid_legacy",
      type: "invoice.paid",
      data: {
        object: {
          id: invoiceId,
          object: "invoice",
          subtotal: 2_000,
          amount_paid: 2_000,
          metadata: {
            terragon_user_id: user.id,
            reason: CREDIT_TOP_UP_REASON,
          },
        } as unknown as Stripe.Invoice,
      },
    } as unknown as Stripe.Event;

    await handleStripeCreditTopUpEvent(event);

    const credits = await getUserCredits({
      db,
      userId: user.id,
      referenceId: `stripe_invoice:${invoiceId}`,
      limit: 5,
    });
    expect(credits).toHaveLength(1);
    expect(credits[0]?.amountCents).toBe(2_000);
    expect(credits[0]?.grantType).toBe("stripe_top_up");
  });

  it("does not double-grant credits for the same invoice", async () => {
    const { user } = await createTestUser({
      db,
      skipBillingFeatureFlag: true,
    });

    const invoiceId = `in_test_duplicate_${nanoid()}`;
    const invoiceEvent = {
      id: "evt_test_invoice_paid_duplicate",
      type: "invoice.paid",
      data: {
        object: {
          id: invoiceId,
          object: "invoice",
          amount_paid: 2_000,
          subtotal: 2_000,
          metadata: {
            leo_user_id: user.id,
            reason: CREDIT_TOP_UP_REASON,
          },
        } as unknown as Stripe.Invoice,
      },
    } as unknown as Stripe.Event;

    await handleStripeCreditTopUpEvent(invoiceEvent);
    await handleStripeCreditTopUpEvent(invoiceEvent);

    const credits = await getUserCredits({
      db,
      userId: user.id,
      referenceId: `stripe_invoice:${invoiceId}`,
      limit: 5,
    });
    expect(credits).toHaveLength(1);
    expect(credits[0]?.amountCents).toBe(2_000);
  });

  it("creates auto-reload credits when invoice reason matches", async () => {
    const { user } = await createTestUser({
      db,
      skipBillingFeatureFlag: true,
    });

    const invoiceId = `in_test_auto_reload_${nanoid()}`;
    const event = {
      id: "evt_test_invoice_auto_reload",
      type: "invoice.paid",
      data: {
        object: {
          id: invoiceId,
          object: "invoice",
          amount_paid: 2_000,
          subtotal: 2_000,
          metadata: {
            leo_user_id: user.id,
            reason: CREDIT_AUTO_RELOAD_REASON,
          },
        } as unknown as Stripe.Invoice,
      },
    } as unknown as Stripe.Event;

    await handleStripeCreditTopUpEvent(event);

    const credits = await getUserCredits({
      db,
      userId: user.id,
      referenceId: `stripe_invoice:${invoiceId}`,
      limit: 5,
    });

    expect(credits).toHaveLength(1);
    expect(credits[0]?.grantType).toBe("stripe_auto_reload");
    expect(credits[0]?.amountCents).toBe(2_000);
  });

  it("persists payment method from payment_intent.succeeded events", async () => {
    const { user } = await createTestUser({
      db,
      skipBillingFeatureFlag: true,
    });
    const event = {
      id: "evt_test_payment_intent_succeeded",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: `pi_test_123_${nanoid()}`,
          object: "payment_intent",
          metadata: {
            leo_user_id: user.id,
            reason: CREDIT_TOP_UP_REASON,
          },
          payment_method: "pm_intent_456",
        } as unknown as Stripe.PaymentIntent,
      },
    } as unknown as Stripe.Event;

    await handleStripeCreditTopUpEvent(event);

    const userInfo = await getUserInfoServerSide({ db, userId: user.id });
    expect(userInfo?.stripeCreditPaymentMethodId).toBe("pm_intent_456");
  });

  it("ignores events without credit metadata", async () => {
    const { user } = await createTestUser({
      db,
      skipBillingFeatureFlag: true,
    });
    const event = {
      id: "evt_test_payment_intent_irrelevant",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_test_789",
          object: "payment_intent",
          metadata: {},
          payment_method: "pm_irrelevant",
        } as unknown as Stripe.PaymentIntent,
      },
    } as unknown as Stripe.Event;
    await handleStripeCreditTopUpEvent(event);
    const userInfo = await getUserInfoServerSide({ db, userId: user.id });
    expect(userInfo?.stripeCreditPaymentMethodId).toBeNull();
  });
});

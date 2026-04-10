import Stripe from "stripe";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import {
  getUser,
  getUserSettings,
  getUserInfoServerSide,
  updateUserInfoServerSide,
} from "@leo/shared/model/user";
import { CREDIT_AUTO_RELOAD_REASON } from "./stripe-credit-top-ups";
import {
  stripeInvoiceItemsCreate,
  stripeInvoicesCreate,
  stripeInvoicesPay,
  stripeInvoicesFinalizeInvoice,
  isStripeConfiguredForCredits,
  getStripeCreditPackPriceId,
} from "./stripe";

const DESCRIPTION = "Leo Credit Auto-Reload";
const AUTO_RELOAD_THRESHOLD_CENTS = 500;
const AUTO_RELOAD_LOCK_TTL_SECONDS = 120;
const AUTO_RELOAD_LOCK_PREFIX = "credits:auto-reload";

export async function maybeTriggerCreditAutoReload({
  userId,
  balanceCents,
}: {
  userId: string;
  balanceCents: number;
}): Promise<void> {
  if (balanceCents >= AUTO_RELOAD_THRESHOLD_CENTS) {
    return;
  }
  if (!isStripeConfiguredForCredits()) {
    return;
  }
  const [user, settings, userInfoServerSide] = await Promise.all([
    getUser({ db, userId }),
    getUserSettings({ db, userId }),
    getUserInfoServerSide({ db, userId }),
  ]);
  if (!user || settings.autoReloadDisabled) {
    return;
  }
  if (
    !user.stripeCustomerId ||
    !userInfoServerSide.stripeCreditPaymentMethodId ||
    shouldSkipAutoReload(userInfoServerSide.autoReloadLastFailureCode)
  ) {
    return;
  }
  const lockKey = `${AUTO_RELOAD_LOCK_PREFIX}:${userId}`;
  const lockResponse = await redis.set(lockKey, "1", {
    nx: true,
    ex: AUTO_RELOAD_LOCK_TTL_SECONDS,
  });
  if (lockResponse !== "OK") {
    return;
  }
  const clearLock = async () => {
    try {
      await redis.del(lockKey);
    } catch (err) {
      console.warn("Failed to release auto-reload lock", {
        userId,
        error: err,
      });
    }
  };

  try {
    await updateUserInfoServerSide({
      db,
      userId,
      updates: {
        autoReloadLastAttemptAt: new Date(),
      },
    });

    // Create invoice first, then add items to it
    const invoice = await stripeInvoicesCreate({
      customer: user.stripeCustomerId,
      default_payment_method: userInfoServerSide.stripeCreditPaymentMethodId,
      auto_advance: false,
      description: DESCRIPTION,
      metadata: {
        leo_user_id: userId,
        terragon_user_id: userId,
        reason: CREDIT_AUTO_RELOAD_REASON,
      },
    });

    if (!invoice.id) {
      throw new Error("Invoice creation failed - no invoice ID");
    }

    // Create invoice item attached to this specific invoice
    await stripeInvoiceItemsCreate({
      invoice: invoice.id,
      customer: user.stripeCustomerId,
      pricing: {
        price: getStripeCreditPackPriceId(),
      },
      description: DESCRIPTION,
      metadata: {
        leo_user_id: userId,
        terragon_user_id: userId,
        reason: CREDIT_AUTO_RELOAD_REASON,
      },
    });

    // Finalize and pay the invoice
    await stripeInvoicesFinalizeInvoice(invoice.id);
    await stripeInvoicesPay(invoice.id, {
      off_session: true,
    });

    await updateUserInfoServerSide({
      db,
      userId,
      updates: {
        autoReloadLastFailureAt: null,
        autoReloadLastFailureCode: null,
      },
    });
  } catch (err) {
    await handleAutoReloadFailure({
      userId,
      error: err,
    });
  } finally {
    await clearLock();
  }
}

async function handleAutoReloadFailure({
  userId,
  error,
}: {
  userId: string;
  error: unknown;
}) {
  console.error("Auto-reload payment failed", { userId, error });
  const stripeCardError =
    error instanceof Stripe.errors.StripeCardError ? error : null;
  const failureCode =
    stripeCardError?.code ??
    (error instanceof Error ? error.message : "unknown_error");
  await updateUserInfoServerSide({
    db,
    userId,
    updates: {
      autoReloadLastFailureAt: new Date(),
      autoReloadLastFailureCode: failureCode,
    },
  });
}

function shouldSkipAutoReload(failureCode: string | null | undefined) {
  const codesToDisable: Array<string | null | undefined> = [
    "payment_method_configuration_failure",
    "authentication_required",
    "card_declined",
    "do_not_honor",
  ];
  return codesToDisable.includes(failureCode);
}

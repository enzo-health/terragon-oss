import Stripe from "stripe";
import { db } from "@/lib/db";
import { getUserCredits, grantUserCredits } from "@leo/shared/model/credits";
import { updateUserInfoServerSide } from "@leo/shared/model/user";

export const CREDIT_TOP_UP_REASON = "credit_top_up";
export const CREDIT_AUTO_RELOAD_REASON = "credit_auto_reload";
export const CREDIT_TOP_UP_AMOUNT_CENTS = 2_000;

type CreditMetadata = {
  userId: string;
  reason: string;
};

function extractCreditMetadata(
  metadata: Stripe.Metadata | null | undefined,
): CreditMetadata | null {
  if (!metadata) {
    return null;
  }
  const reason = metadata.reason;
  const userId = metadata.leo_user_id ?? metadata.terragon_user_id;
  if (typeof userId !== "string" || userId.length === 0) {
    return null;
  }
  if (
    typeof reason !== "string" ||
    (reason !== CREDIT_TOP_UP_REASON && reason !== CREDIT_AUTO_RELOAD_REASON)
  ) {
    return null;
  }
  return { userId, reason };
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const metadata = extractCreditMetadata(invoice.metadata);
  if (!metadata) {
    return;
  }
  const { userId, reason } = metadata;
  const invoiceId = invoice.id;
  console.log("Stripe credit top-up invoice paid", {
    invoiceId,
    metadata,
    "invoice.discounts": invoice.discounts,
    "invoice.subtotal": invoice.subtotal,
    "invoice.amount_paid": invoice.amount_paid,
  });
  const subtotalCents = Number(invoice.subtotal ?? 0);
  const amountPaidCents = Number(invoice.amount_paid ?? 0);
  if (
    !Number.isFinite(subtotalCents) ||
    subtotalCents <= 0 ||
    !Number.isFinite(amountPaidCents)
  ) {
    console.warn(
      "Stripe credit top-up skipped: invalid amount",
      invoiceId,
      subtotalCents,
      amountPaidCents,
    );
    return;
  }
  console.log("Stripe credit top-up succeeded via invoice", {
    userId,
    invoiceId,
    reason,
    subtotalCents,
    amountPaidCents,
  });
  const referenceId = `stripe_invoice:${invoiceId}`;
  const description =
    reason === CREDIT_AUTO_RELOAD_REASON
      ? `Stripe credit auto-reload ${invoiceId}`
      : `Stripe credit top-up ${invoiceId}`;
  const existingCredits = await getUserCredits({
    db,
    userId,
    referenceId,
    limit: 1,
  });
  if (existingCredits.length > 0) {
    return;
  }
  await grantUserCredits({
    db,
    grants: {
      userId,
      amountCents: CREDIT_TOP_UP_AMOUNT_CENTS,
      grantType:
        reason === CREDIT_AUTO_RELOAD_REASON
          ? "stripe_auto_reload"
          : "stripe_top_up",
      description,
      referenceId,
    },
  });
  await updateUserInfoServerSide({
    db,
    userId,
    updates: {
      // Reset auto-reload failure state when a credit top-up is successfully granted
      autoReloadLastFailureAt: null,
      autoReloadLastFailureCode: null,
    },
  });
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const metadata = extractCreditMetadata(invoice.metadata);
  if (!metadata) {
    return;
  }
  console.warn("Stripe credit top-up invoice payment failed", {
    invoiceId: invoice.id,
    userId: metadata.userId,
    reason: metadata.reason,
  });
}

function extractIdFromPaymentMethod(
  paymentMethod: Stripe.PaymentIntent["payment_method"] | null | undefined,
): string | null {
  if (!paymentMethod) {
    return null;
  }
  if (typeof paymentMethod === "string") {
    return paymentMethod;
  }
  if (typeof paymentMethod === "object" && "id" in paymentMethod) {
    return paymentMethod.id ?? null;
  }
  return null;
}

async function handlePaymentIntentSucceeded(
  paymentIntent: Stripe.PaymentIntent,
) {
  const metadata = extractCreditMetadata(paymentIntent.metadata);
  if (!metadata) {
    return;
  }
  const paymentMethodId = extractIdFromPaymentMethod(
    paymentIntent.payment_method,
  );
  if (!paymentMethodId) {
    console.warn(
      "Stripe credit top-up payment intent missing payment method",
      paymentIntent.id,
    );
    return;
  }
  await updateUserInfoServerSide({
    db,
    userId: metadata.userId,
    updates: {
      stripeCreditPaymentMethodId: paymentMethodId,
      // Reset auto-reload failure state when a payment method is successfully set
      autoReloadLastFailureAt: null,
      autoReloadLastFailureCode: null,
    },
  });
}

export async function handleStripeCreditTopUpEvent(event: Stripe.Event) {
  switch (event.type) {
    case "invoice.paid":
      await handleInvoicePaid(event.data.object as Stripe.Invoice);
      break;
    case "invoice.payment_failed":
      await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
      break;
    case "payment_intent.succeeded":
      await handlePaymentIntentSucceeded(
        event.data.object as Stripe.PaymentIntent,
      );
      break;
    default:
      break;
  }
}

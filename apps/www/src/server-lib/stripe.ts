import Stripe from "stripe";

const BILLING_DISABLED_MESSAGE =
  "Billing is disabled in internal single-tenant mode.";

export function isStripeConfigured(): boolean {
  return false;
}

export function isStripeConfiguredForCredits(): boolean {
  return false;
}

export function assertStripeConfigured(): void {
  if (!isStripeConfigured()) {
    throw new Error(BILLING_DISABLED_MESSAGE);
  }
}

export function assertStripeConfiguredForCredits(): void {
  if (!isStripeConfiguredForCredits()) {
    throw new Error(BILLING_DISABLED_MESSAGE);
  }
}

export function getStripeClient(): Stripe {
  throw new Error(BILLING_DISABLED_MESSAGE);
}

export const STRIPE_PLAN_CONFIGS = [];

function stripeDisabledError(): never {
  throw new Error(BILLING_DISABLED_MESSAGE);
}

export function getStripeWebhookSecret(): string {
  stripeDisabledError();
}

export function getStripeCreditPackPriceId(): string {
  stripeDisabledError();
}

/**
 * Wrappers for Stripe API methods to make them easier to mock in tests
 */
export async function stripeCheckoutSessionsCreate(
  _params: Stripe.Checkout.SessionCreateParams,
): Promise<Stripe.Checkout.Session> {
  stripeDisabledError();
}

export async function stripeCustomersCreate(
  _params: Stripe.CustomerCreateParams,
): Promise<Stripe.Customer> {
  stripeDisabledError();
}

export function stripeInvoicesCreate(
  _params: Stripe.InvoiceCreateParams,
): Promise<Stripe.Invoice> {
  stripeDisabledError();
}

export function stripeInvoiceItemsCreate(
  _params: Stripe.InvoiceItemCreateParams,
): Promise<Stripe.InvoiceItem> {
  stripeDisabledError();
}

export function stripeInvoicesFinalizeInvoice(
  _invoiceId: string,
): Promise<Stripe.Invoice> {
  stripeDisabledError();
}

export function stripeInvoicesPay(
  _invoiceId: string,
  _params: Stripe.InvoicePayParams,
): Promise<Stripe.Invoice> {
  stripeDisabledError();
}

export function stripeCouponsCreate(
  _params: Stripe.CouponCreateParams,
): Promise<Stripe.Coupon> {
  stripeDisabledError();
}

export function stripePromotionCodesCreate(
  _params: Stripe.PromotionCodeCreateParams,
  _options?: Stripe.RequestOptions,
): Promise<Stripe.PromotionCode> {
  stripeDisabledError();
}

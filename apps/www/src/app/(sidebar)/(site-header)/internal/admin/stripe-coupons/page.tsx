import { getAdminUserOrThrow } from "@/lib/auth-server";

export default async function AdminStripeCouponsPage() {
  await getAdminUserOrThrow();
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold tracking-tight">Stripe coupons</h1>
      <p className="text-sm text-muted-foreground">
        Stripe coupon management is disabled in internal single-tenant mode.
      </p>
    </div>
  );
}

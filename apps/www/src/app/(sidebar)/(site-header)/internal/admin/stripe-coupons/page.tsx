import { getAdminUserOrThrow } from "@/lib/auth-server";

export default async function AdminStripeCouponsPage() {
  await getAdminUserOrThrow();
  return (
    <div className="px-4 py-6 text-muted-foreground">
      Stripe coupon management is disabled in internal single-tenant mode.
    </div>
  );
}

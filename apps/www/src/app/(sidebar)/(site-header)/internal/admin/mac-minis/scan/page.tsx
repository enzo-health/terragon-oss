import { getAdminUserOrThrow, getUserIdOrNull } from "@/lib/auth-server";
import { MacMiniScan } from "@/components/admin/mac-mini-scan";
import { redirect } from "next/navigation";

export default async function AdminMacMiniScanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        query.append(key, item);
      }
    } else if (typeof value === "string") {
      query.append(key, value);
    }
  }

  const scanUrl = query.toString()
    ? `/internal/admin/mac-minis/scan?${query.toString()}`
    : "/internal/admin/mac-minis/scan";

  const userId = await getUserIdOrNull();
  if (!userId) {
    redirect(`/login?returnUrl=${encodeURIComponent(scanUrl)}`);
  }

  await getAdminUserOrThrow();
  return <MacMiniScan />;
}

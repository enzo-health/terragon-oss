import { getAdminUserOrThrow } from "@/lib/auth-server";
import { getMacMiniFleet } from "@/server-actions/admin/mac-mini";
import { MacMinisContent } from "@/components/admin/mac-minis-content";

export default async function AdminMacMinisPage() {
  await getAdminUserOrThrow();
  const workers = await getMacMiniFleet();
  return <MacMinisContent workers={workers} />;
}

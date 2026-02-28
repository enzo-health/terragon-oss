import { getAdminUserOrThrow } from "@/lib/auth-server";
import { ShutdownControls } from "@/components/admin/shutdown-controls";

export default async function ShutdownAdminPage() {
  await getAdminUserOrThrow();
  return <ShutdownControls />;
}

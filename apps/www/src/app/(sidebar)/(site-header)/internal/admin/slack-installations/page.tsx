import { AdminSlackInstallations } from "@/components/admin/slack-installations";
import { getAdminUserOrThrow } from "@/lib/auth-server";
import { getSlackInstallationsForAdmin } from "@leo/shared/model/slack";
import { db } from "@/lib/db";

export default async function SlackInstallationsPage() {
  await getAdminUserOrThrow();
  const installations = await getSlackInstallationsForAdmin({ db });
  return <AdminSlackInstallations installations={installations} />;
}

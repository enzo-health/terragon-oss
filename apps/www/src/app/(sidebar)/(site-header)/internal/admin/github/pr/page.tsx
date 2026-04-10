import { getAdminUserOrThrow } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { AdminGithub } from "@/components/admin/github";
import { getRecentGithubPRsForAdmin } from "@leo/shared/model/github";

export default async function AdminGithubPage() {
  await getAdminUserOrThrow();
  const prs = await getRecentGithubPRsForAdmin({ db, limit: 200 });
  return <AdminGithub prs={prs} />;
}

import { getAdminUserOrThrow } from "@/lib/auth-server";

export default async function AdminReengagementPage() {
  await getAdminUserOrThrow();

  return (
    <div className="px-4 py-6 text-muted-foreground">
      Re-engagement campaigns are disabled in internal mode.
    </div>
  );
}

import { getAdminUserOrThrow } from "@/lib/auth-server";

export default async function AdminReengagementPage() {
  await getAdminUserOrThrow();

  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold tracking-tight">Re-engagement</h1>
      <p className="text-sm text-muted-foreground">
        Re-engagement campaigns are disabled in internal mode.
      </p>
    </div>
  );
}

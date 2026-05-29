import { AdminSandboxContent } from "@/components/admin/sandbox-content";
import { getAdminUserOrThrow } from "@/lib/auth-server";

export default async function AdminSandboxPage() {
  await getAdminUserOrThrow();
  return (
    <AdminSandboxContent
      sandboxProvider={null}
      sandboxId={null}
      initialLogLines={null}
    />
  );
}

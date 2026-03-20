import { AdminSandboxContent } from "@/components/admin/sandbox-content";
import { getAdminUserOrThrow } from "@/lib/auth-server";

export default async function AdminSandboxIdPage({
  params,
}: {
  params: Promise<{ providerAndId: string[] }>;
}) {
  await getAdminUserOrThrow();
  const { providerAndId } = await params;
  if (providerAndId.length === 1) {
    return (
      <AdminSandboxContent
        sandboxProvider="e2b"
        sandboxId={providerAndId[0]!}
      />
    );
  }
  if (providerAndId.length === 2) {
    switch (providerAndId[0]) {
      case "e2b":
        return (
          <AdminSandboxContent
            sandboxProvider="e2b"
            sandboxId={providerAndId[1]!}
          />
        );
      case "daytona":
        return (
          <AdminSandboxContent
            sandboxProvider="daytona"
            sandboxId={providerAndId[1]!}
          />
        );
      case "docker":
        return (
          <AdminSandboxContent
            sandboxProvider="docker"
            sandboxId={providerAndId[1]!}
          />
        );
      default:
        throw new Error(`Invalid provider ${providerAndId[0]}`);
    }
  }
  throw new Error(
    `Invalid path ${providerAndId.join("/")}, expected /provider/id or /id`,
  );
}

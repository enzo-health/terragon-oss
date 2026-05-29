import { AdminSandboxContent } from "@/components/admin/sandbox-content";
import { getAdminUserOrThrow } from "@/lib/auth-server";
import { getSandboxDaemonLogs } from "@/server-actions/admin/sandbox";
import type { SandboxProvider } from "@terragon/types/sandbox";

async function renderSandboxContent(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
) {
  const initialLogLines = await getSandboxDaemonLogs({
    sandboxProvider,
    sandboxId,
  });
  return (
    <AdminSandboxContent
      sandboxProvider={sandboxProvider}
      sandboxId={sandboxId}
      initialLogLines={initialLogLines}
    />
  );
}

export default async function AdminSandboxIdPage({
  params,
}: {
  params: Promise<{ providerAndId: string[] }>;
}) {
  await getAdminUserOrThrow();
  const { providerAndId } = await params;
  if (providerAndId.length === 1) {
    return renderSandboxContent("e2b", providerAndId[0]!);
  }
  if (providerAndId.length === 2) {
    switch (providerAndId[0]) {
      case "e2b":
        return renderSandboxContent("e2b", providerAndId[1]!);
      case "daytona":
        return renderSandboxContent("daytona", providerAndId[1]!);
      case "docker":
        return renderSandboxContent("docker", providerAndId[1]!);
      default:
        throw new Error(`Invalid provider ${providerAndId[0]}`);
    }
  }
  throw new Error(
    `Invalid path ${providerAndId.join("/")}, expected /provider/id or /id`,
  );
}

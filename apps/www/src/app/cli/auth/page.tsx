import { getUserIdOrNull } from "@/lib/auth-server";
import { CLIAuth } from "@/components/cli/main";
import { redirect } from "next/navigation";
import { env } from "@leo/env/apps-www";

export default async function CLIAuthPage() {
  const userId = await getUserIdOrNull();
  if (!userId) {
    redirect(`/login?returnUrl=${encodeURIComponent("/cli/auth")}`);
    return;
  }
  return <CLIAuth cliPort={env.CLI_PORT} />;
}

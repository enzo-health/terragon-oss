import { IntegrationsSettings } from "@/components/settings/tab/integrations";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getSlackAccounts } from "@terragon/shared/model/slack";
import { getLinearAccountsWithSettings } from "@terragon/shared/model/linear";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Integrations Settings | Terragon",
};

export default async function IntegrationsSettingsPage() {
  const userId = await getUserIdOrRedirect();
  const [slackAccounts, linearAccounts] = await Promise.all([
    getSlackAccounts({ db, userId }),
    getLinearAccountsWithSettings({ db, userId }),
  ]);
  return (
    <IntegrationsSettings
      slackAccounts={slackAccounts}
      linearAccounts={linearAccounts}
    />
  );
}

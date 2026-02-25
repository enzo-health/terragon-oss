import { IntegrationsSettings } from "@/components/settings/tab/integrations";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getSlackAccounts } from "@terragon/shared/model/slack";
import {
  getLinearAccountsWithSettings,
  getLinearInstallation,
} from "@terragon/shared/model/linear";
import { LinearAccountWithSettingsAndInstallation } from "@terragon/shared/db/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Integrations Settings | Terragon",
};

export default async function IntegrationsSettingsPage() {
  const userId = await getUserIdOrRedirect();
  const [slackAccounts, linearAccountsWithSettings, linearInstallation] =
    await Promise.all([
      getSlackAccounts({ db, userId }),
      getLinearAccountsWithSettings({ db, userId }),
      getLinearInstallation({ db }),
    ]);

  // Join: accounts whose organizationId matches the active installation get it
  // populated; all others get null. Supports multi-org scenario.
  const linearAccounts: LinearAccountWithSettingsAndInstallation[] =
    linearAccountsWithSettings.map((account) => ({
      ...account,
      installation:
        linearInstallation &&
        account.organizationId === linearInstallation.organizationId
          ? linearInstallation
          : null,
    }));

  return (
    <IntegrationsSettings
      slackAccounts={slackAccounts}
      linearAccounts={linearAccounts}
      linearInstallation={linearInstallation}
    />
  );
}

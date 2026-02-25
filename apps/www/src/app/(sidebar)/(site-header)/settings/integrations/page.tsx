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

  // Join: accounts whose organizationId matches the installation (active or
  // inactive) get it populated; others get null. Inactive installations are
  // surfaced deliberately to drive the "Reinstall required" UI state.
  // Supports multi-org scenario (one Terragon deployment, multiple accounts).
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

"use client";

import { useAtomValue } from "jotai";
import { userAtom } from "@/atoms/user";
import { SlackAccountSettings } from "../slack";
import { SlackAuthToasts } from "../slack-auth-toasts";
import { LinearAccountSettings } from "../linear";
import {
  SlackAccountWithMetadata,
  LinearAccountWithSettingsAndInstallation,
  LinearInstallationPublic,
} from "@terragon/shared/db/types";
import { SettingsSection } from "../settings-row";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import Link from "next/link";

interface IntegrationsSettingsProps {
  slackAccounts?: SlackAccountWithMetadata[];
  linearAccounts?: LinearAccountWithSettingsAndInstallation[];
  linearInstallation?: LinearInstallationPublic | null;
}

export function IntegrationsSettings({
  slackAccounts = [],
  linearAccounts = [],
  linearInstallation = null,
}: IntegrationsSettingsProps) {
  const user = useAtomValue(userAtom);
  const isLinearEnabled = useFeatureFlag("linearIntegration");
  if (!user) {
    return null;
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Slack Integration */}
      <SettingsSection
        label="Slack"
        description={
          <>
            Connect your Slack workspace to interact with Terragon through
            Slack.{" "}
            <Link
              href="https://docs.terragonlabs.com/docs/integrations/slack-integration"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
            >
              Learn more about the Slack integration.
            </Link>
          </>
        }
      >
        <SlackAuthToasts />
        <SlackAccountSettings accounts={slackAccounts} />
      </SettingsSection>

      {/* Linear Integration */}
      {isLinearEnabled && (
        <SettingsSection
          label="Linear"
          description={
            <>
              Install the Linear Agent in your workspace, then link your account
              so Terragon can respond to mentions on your behalf.{" "}
              <Link
                href="https://docs.terragonlabs.com/docs/integrations/linear-integration"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                Learn more about the Linear integration.
              </Link>
            </>
          }
        >
          <LinearAccountSettings
            accounts={linearAccounts}
            installation={linearInstallation}
          />
        </SettingsSection>
      )}
    </div>
  );
}

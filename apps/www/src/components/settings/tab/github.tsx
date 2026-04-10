"use client";

import { useAtomValue } from "jotai";
import {
  userAtom,
  userSettingsAtom,
  useUpdateUserSettingsMutation,
} from "@/atoms/user";
import { BranchPrefixSetting } from "@/components/settings/branch-prefix-setting";
import {
  SettingsCheckbox,
  SettingsWithCTA,
  SettingsWithExternalLink,
  SettingsSection,
} from "@/components/settings/settings-row";
import { getGHAppInstallUrl } from "@/lib/gh-app-url";
import { PullRequestStageSetting } from "@/components/settings/pull-request-stage-setting";
import { ModelSelector } from "@/components/model-selector";
import { AIModel } from "@leo/agent/types";
import { userFlagsAtom } from "@/atoms/user-flags";

export function GitHubSettings() {
  const user = useAtomValue(userAtom);
  const userSettings = useAtomValue(userSettingsAtom);
  const userFlags = useAtomValue(userFlagsAtom);
  const userSettingsMutation = useUpdateUserSettingsMutation();

  if (!user || !userSettings || !userFlags) {
    return null;
  }

  return (
    <div className="flex flex-col gap-12">
      {/* Repository Configuration */}
      <SettingsSection label="Repository Configuration">
        <div className="flex flex-col gap-4">
          <SettingsWithExternalLink
            label="Repository access"
            description="Manage which GitHub repositories Leo can access"
            href={getGHAppInstallUrl()}
          />
          <SettingsWithExternalLink
            label="Environment settings"
            description="Configure custom sandbox environments for each of your repositories"
            href="/environments"
          />
        </div>
      </SettingsSection>

      <SettingsSection
        label="Pull Request Defaults"
        description="Configure how Leo creates and manages pull requests"
      >
        <div className="flex flex-col gap-4">
          <SettingsWithCTA
            label="Default pull request stage"
            description="Set the default stage of pull requests Leo creates"
          >
            <PullRequestStageSetting />
          </SettingsWithCTA>
          <BranchPrefixSetting
            value={userSettings.branchNamePrefix}
            onSave={async (prefix) => {
              await userSettingsMutation.mutateAsync({
                branchNamePrefix: prefix,
              });
            }}
          />
          <SettingsCheckbox
            label="Archive task when related pull request is merged or closed"
            description="Automatically archive tasks when the related pull request is merged or closed."
            value={!!userSettings.autoArchiveMergedPRs}
            onCheckedChange={async (checked) => {
              await userSettingsMutation.mutateAsync({
                autoArchiveMergedPRs: !!checked,
              });
            }}
          />
          <SettingsCheckbox
            label="Close your pull requests when task is archived"
            description="Automatically close pull requests that you created when the related task is archived."
            value={!!userSettings.autoClosePRsOnArchive}
            onCheckedChange={async (checked) => {
              await userSettingsMutation.mutateAsync({
                autoClosePRsOnArchive: !!checked,
              });
            }}
          />
          <SettingsCheckbox
            label="Create pull request when changes are pushed"
            description="Automatically create pull requests when changes are made."
            value={!!userSettings.autoCreatePRs}
            onCheckedChange={async (checked) => {
              await userSettingsMutation.mutateAsync({
                autoCreatePRs: !!checked,
              });
            }}
          />
        </div>
      </SettingsSection>

      {/* @-mention settings */}
      <SettingsSection
        label="@leo-labs Defaults"
        description="Configure what happens when @leo-labs is tagged on GitHub"
      >
        <div className="flex flex-col gap-4">
          <SettingsCheckbox
            label="Create new task when @leo-labs is tagged on GitHub"
            description="Instead of adding follow-up messages to a pull request's existing task."
            value={!userSettings.singleThreadForGitHubMentions}
            onCheckedChange={async (checked) => {
              await userSettingsMutation.mutateAsync({
                singleThreadForGitHubMentions: !checked,
              });
            }}
          />
          <SettingsWithCTA
            label="Default model for new tasks"
            description="When new tasks are created, choose the default model to use. Follow-up messages will use the last model used in the task."
            direction="col"
          >
            <div className="space-y-1">
              <ModelSelector
                className="border-solid p-2 text-foreground !bg-muted"
                forcedAgent={null}
                forcedAgentVersion={null}
                isMultiAgentMode={false}
                supportsMultiAgentPromptSubmission={false}
                setIsMultiAgentMode={() => {}}
                selectedModels={{}}
                selectedModel={
                  userSettings.defaultGitHubMentionModel ??
                  userFlags.selectedModel ??
                  undefined
                }
                setSelectedModel={async ({ model }: { model: AIModel }) => {
                  await userSettingsMutation.mutateAsync({
                    defaultGitHubMentionModel: model,
                  });
                }}
              />
            </div>
          </SettingsWithCTA>
        </div>
      </SettingsSection>
    </div>
  );
}

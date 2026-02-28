"use client";

import { GitHubMentionTriggerConfig } from "@terragon/shared/automations";
import { FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RepoSelector } from "../repo-branch-selector";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

export function GitHubMentionTriggerForm({
  value,
  repoFullName,
  setRepoFullName,
  onChange,
  errorMessage,
}: {
  value: GitHubMentionTriggerConfig;
  repoFullName: string;
  setRepoFullName: (repoFullName: string) => void;
  onChange: (value: GitHubMentionTriggerConfig) => void;
  errorMessage?: string;
}) {
  const includeBotMentions = value.filter.includeBotMentions ?? false;

  return (
    <div className="space-y-4 border rounded-lg p-4">
      <div className="space-y-2">
        <FormLabel>Repository</FormLabel>
        <RepoSelector
          selectedRepoFullName={repoFullName}
          onChange={(repoFullName) => {
            if (repoFullName) {
              setRepoFullName(repoFullName);
            }
          }}
        />
      </div>
      <div className="space-y-2">
        <FormLabel>Mention filters</FormLabel>

        <div className="space-y-3">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="includeBotMentions"
              checked={includeBotMentions}
              onCheckedChange={(checked) => {
                const nextIncludeBotMentions = checked === true;
                onChange({
                  ...value,
                  filter: {
                    ...value.filter,
                    includeBotMentions: nextIncludeBotMentions,
                  },
                });
              }}
            />
            <Label
              htmlFor="includeBotMentions"
              className="text-sm font-normal flex items-center gap-2 cursor-pointer"
            >
              <span>Include mentions from bot users</span>
            </Label>
          </div>
          {includeBotMentions && (
            <div className="space-y-2 pl-6">
              <FormLabel>Bot usernames</FormLabel>
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <strong>Security Notice:</strong> Make sure you trust these
                  bot users. Their mentions will be read directly by the agent
                  when the automation runs.
                </AlertDescription>
              </Alert>
              <Input
                value={value.filter.botUsernames || ""}
                placeholder="e.g., sentry-io[bot], copilot[bot]"
                onChange={(e) =>
                  onChange({
                    ...value,
                    filter: { ...value.filter, botUsernames: e.target.value },
                  })
                }
              />
            </div>
          )}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="includeOtherAuthors"
              checked={value.filter.includeOtherAuthors || false}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  filter: {
                    ...value.filter,
                    includeOtherAuthors: checked as boolean,
                  },
                })
              }
            />
            <Label
              htmlFor="includeOtherAuthors"
              className="text-sm font-normal"
            >
              Include mentions on PRs/Issues created by other authors
            </Label>
          </div>
          {value.filter.includeOtherAuthors && (
            <>
              <div className="space-y-2 pl-6">
                <FormLabel>Other authors</FormLabel>
                <Input
                  value={value.filter.otherAuthors || ""}
                  placeholder="e.g., teammate1, teammate2"
                  onChange={(e) =>
                    onChange({
                      ...value,
                      filter: {
                        ...value.filter,
                        otherAuthors: e.target.value,
                      },
                    })
                  }
                />
              </div>
            </>
          )}
        </div>
      </div>
      {errorMessage && (
        <p className="text-sm text-destructive">{errorMessage}</p>
      )}
    </div>
  );
}

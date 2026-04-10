"use client";

import { PullRequestTriggerConfig } from "@leo/shared/automations";
import { FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RepoSelector } from "../repo-branch-selector";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

export function PullRequestTriggerForm({
  value,
  repoFullName,
  setRepoFullName,
  onChange,
  errorMessage,
}: {
  value: PullRequestTriggerConfig;
  repoFullName: string;
  setRepoFullName: (repoFullName: string) => void;
  onChange: (value: PullRequestTriggerConfig) => void;
  errorMessage?: string;
}) {
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
        <FormLabel>When to trigger</FormLabel>
        <div className="space-y-3">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="onOpen"
              checked={value.on.open || false}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  on: { ...value.on, open: checked as boolean },
                })
              }
            />
            <Label htmlFor="onOpen" className="text-sm font-normal">
              When a pull request is opened
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="onUpdate"
              checked={value.on.update || false}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  on: { ...value.on, update: checked as boolean },
                })
              }
            />
            <Label htmlFor="onUpdate" className="text-sm font-normal">
              When a pull request is updated with new commits
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="draft"
              checked={value.filter.includeDraftPRs}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  filter: {
                    ...value.filter,
                    includeDraftPRs: checked as boolean,
                  },
                })
              }
            />
            <Label htmlFor="draft" className="text-sm font-normal">
              Include draft pull requests
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="otherAuthor"
              checked={value.filter.includeOtherAuthors}
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
            <Label htmlFor="otherAuthor" className="text-sm font-normal">
              Include pull requests from other authors
            </Label>
          </div>
          {value.filter.includeOtherAuthors && (
            <div className="space-y-2">
              <FormLabel>Other authors</FormLabel>
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <strong>Security Notice:</strong> Make sure you trust these
                  authors. Their pull request contents will be read directly by
                  the agent when the automation runs.
                </AlertDescription>
              </Alert>
              <Input
                value={value.filter.otherAuthors || ""}
                placeholder="e.g., octocat, sentry-io[bot], other-author"
                onChange={(e) =>
                  onChange({
                    ...value,
                    filter: { ...value.filter, otherAuthors: e.target.value },
                  })
                }
              />
            </div>
          )}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="autoArchive"
              checked={value.autoArchiveOnComplete}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  autoArchiveOnComplete: checked as boolean,
                })
              }
            />
            <Label htmlFor="autoArchive" className="text-sm font-normal">
              Archive task when agent completes
            </Label>
          </div>
        </div>
      </div>
      {errorMessage && (
        <p className="text-sm text-destructive">{errorMessage}</p>
      )}
    </div>
  );
}

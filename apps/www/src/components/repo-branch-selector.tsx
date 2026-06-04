"use client";

import React, { memo, useCallback, useMemo, useState } from "react";
import { GitBranch, Github, Settings } from "lucide-react";
import { ResponsiveCombobox } from "@/components/ui/responsive-combobox";
import {
  useUserRepoBranchesQuery,
  useUserReposQuery,
} from "@/queries/user-repo-queries";
import { getGHAppInstallUrl } from "@/lib/gh-app-url";
import { cn } from "@/lib/utils";

function openGitHubAppInstallUrl() {
  window.open(getGHAppInstallUrl(), "_blank");
}

function RepoSelectorInner({
  selectedRepoFullName,
  onChange,
}: {
  selectedRepoFullName: string | null;
  onChange: (repoFullName: string | null) => void;
}) {
  const { data: repoData, isLoading: isLoadingRepos } = useUserReposQuery();
  const repos = repoData?.repos;
  const repoItems = useMemo(() => {
    const items = [];
    if (repos) {
      items.push(
        ...repos.map((repo) => ({
          value: repo.full_name,
          label: repo.full_name,
        })),
      );
    } else if (selectedRepoFullName) {
      items.push({
        value: selectedRepoFullName,
        label: selectedRepoFullName,
      });
    }
    return items;
  }, [selectedRepoFullName, repos]);

  const repoByFullName = useMemo(() => {
    return Object.fromEntries(
      repos?.map((repo) => [repo.full_name, repo]) ?? [],
    );
  }, [repos]);

  const actionItems = useMemo(
    () => [
      {
        value: "manage-github-apps",
        label: "Manage repository access",
        icon: <Settings className="size-4 shrink-0" />,
        action: openGitHubAppInstallUrl,
      },
    ],
    [],
  );
  const emptyRepoText = useCallback((didSearch: boolean) => {
    if (!didSearch) {
      return "Add a repo to get started";
    }
    return "No repositories found";
  }, []);
  const handleRepoChange = useCallback(
    (newRepoFullName: string) => {
      if (isLoadingRepos) {
        return;
      }
      onChange(newRepoFullName);
    },
    [isLoadingRepos, onChange],
  );

  const displayRepoFullName = isLoadingRepos
    ? (selectedRepoFullName ?? null)
    : repoByFullName[selectedRepoFullName ?? ""]
      ? selectedRepoFullName
      : null;

  return (
    <ResponsiveCombobox
      items={repoItems}
      actionItems={actionItems}
      value={displayRepoFullName ?? null}
      setValue={handleRepoChange}
      placeholder="Select a repo"
      searchPlaceholder="Search repositories"
      emptyText={emptyRepoText}
      isLoading={isLoadingRepos}
      loadingText="Loading repositories…"
      disabled={false}
      variant="outline"
    />
  );
}

function RepoBranchSelectorInner({
  hideRepoSelector,
  repoSelectorClassName,
  branchSelectorClassName,
  selectedRepoFullName,
  selectedBranch,
  onChange,
}: {
  hideRepoSelector?: boolean;
  repoSelectorClassName?: string;
  branchSelectorClassName?: string;
  selectedRepoFullName: string | null;
  selectedBranch: string | null;
  onChange: (
    repoFullName: string | null,
    branch: string | null,
    isDefaultBranch?: boolean,
  ) => void;
}) {
  const { data: repoData, isLoading: isLoadingRepos } = useUserReposQuery();
  const repos = repoData?.repos;

  const [loadBranches, setLoadBranches] = useState(false);
  const { data: branches, isLoading: isLoadingBranches } =
    useUserRepoBranchesQuery(selectedRepoFullName, {
      enabled: loadBranches,
    });

  const repoItems = useMemo(() => {
    const items = [];

    if (repos) {
      items.push(
        ...repos.map((repo) => ({
          value: repo.full_name,
          label: repo.full_name,
        })),
      );
    } else if (selectedRepoFullName) {
      items.push({
        value: selectedRepoFullName,
        label: selectedRepoFullName,
      });
    }
    return items;
  }, [selectedRepoFullName, repos]);

  const repoByFullName = useMemo(() => {
    return Object.fromEntries(
      repos?.map((repo) => [repo.full_name, repo]) ?? [],
    );
  }, [repos]);

  const actionItems = useMemo(
    () => [
      {
        value: "manage-github-apps",
        label: "Manage repository access",
        icon: <Settings className="size-4 shrink-0" />,
        action: openGitHubAppInstallUrl,
      },
    ],
    [],
  );
  const emptyRepoText = useCallback((didSearch: boolean) => {
    if (!didSearch) {
      return "Add a repo to get started";
    }
    return "No repositories found";
  }, []);
  const handleRepoChange = useCallback(
    (newRepoFullName: string) => {
      if (isLoadingRepos) {
        return;
      }
      if (newRepoFullName === "") {
        onChange(null, null);
        setLoadBranches(false);
        return;
      }

      const repo = repoByFullName[newRepoFullName];
      const newBranch = repo?.default_branch ?? "main";
      setLoadBranches(false);
      onChange(newRepoFullName, newBranch, repo?.default_branch === newBranch);
    },
    [isLoadingRepos, onChange, repoByFullName],
  );
  const handleLoadBranches = useCallback(() => {
    setLoadBranches(true);
  }, []);
  const branchItems = useMemo(
    () =>
      branches?.map((branch) => ({
        value: branch.name,
        label: branch.name,
      })) ??
      (selectedBranch
        ? [
            {
              value: selectedBranch,
              label: selectedBranch,
            },
          ]
        : []),
    [branches, selectedBranch],
  );
  const handleBranchChange = useCallback(
    (newBranch: string) => {
      onChange(selectedRepoFullName, newBranch);
    },
    [onChange, selectedRepoFullName],
  );

  const displayRepoFullName = isLoadingRepos
    ? (selectedRepoFullName ?? null)
    : repoByFullName[selectedRepoFullName ?? ""]
      ? selectedRepoFullName
      : null;
  const displaySelectedBranch =
    isLoadingBranches || !loadBranches
      ? (selectedBranch ?? null)
      : branches?.find((branch) => branch.name === selectedBranch)
        ? selectedBranch
        : null;
  return (
    <div className="flex flex-row items-center gap-2 sm:gap-4 px-2 sm:px-4 min-w-0">
      {!hideRepoSelector && (
        <ResponsiveCombobox
          icon={<Github className="size-4 shrink-0 hidden sm:block" />}
          items={repoItems}
          actionItems={actionItems}
          value={displayRepoFullName ?? null}
          setValue={handleRepoChange}
          placeholder="Select a repo"
          searchPlaceholder="Search repositories"
          emptyText={emptyRepoText}
          isLoading={isLoadingRepos}
          loadingText="Loading repositories…"
          disabled={false}
          className={cn(repoSelectorClassName, "min-w-0")}
        />
      )}
      <ResponsiveCombobox
        icon={<GitBranch className="size-4 shrink-0 hidden sm:block" />}
        className={cn(branchSelectorClassName, "min-w-12")}
        key={selectedRepoFullName ?? "no-repo"}
        onLoadItems={handleLoadBranches}
        items={branchItems}
        value={displaySelectedBranch ?? null}
        setValue={handleBranchChange}
        placeholder="Select a branch"
        searchPlaceholder="Search branches"
        emptyText="No branches found"
        isLoading={isLoadingBranches}
        disabled={selectedRepoFullName === null}
      />
    </div>
  );
}

export const RepoBranchSelector = memo(RepoBranchSelectorInner);
export const RepoSelector = memo(RepoSelectorInner);

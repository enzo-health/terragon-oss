"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import {
  promptPreferencesPersistedAtom,
  selectedBranchAtom,
  selectedRepoAtom,
} from "@/atoms/user-flags";

export function useSelectedRepo() {
  const [selectedRepo, setSelectedRepo] = useAtom(selectedRepoAtom);
  return [selectedRepo, setSelectedRepo] as const;
}

export function useSelectedBranch(): [
  string | null,
  (branch: string | null) => void,
] {
  const [selectedBranch, setSelectedBranch] = useAtom(selectedBranchAtom);
  return [selectedBranch, setSelectedBranch];
}

export function useSelectedRepoAndBranch(): {
  selectedRepo: string | null;
  selectedBranch: string | null;
  setSelectedRepoAndBranch: (
    repo: string | null,
    branch: string | null,
  ) => Promise<void>;
} {
  const selectedRepo = useAtomValue(selectedRepoAtom);
  const selectedBranch = useAtomValue(selectedBranchAtom);
  const setPromptPreferences = useSetAtom(promptPreferencesPersistedAtom);

  const setSelectedRepoAndBranch = useCallback(
    async (repo: string | null, branch: string | null) => {
      await setPromptPreferences({
        selectedRepo: repo,
        selectedBranch: branch,
      });
    },
    [setPromptPreferences],
  );

  return {
    selectedRepo,
    selectedBranch,
    setSelectedRepoAndBranch,
  };
}

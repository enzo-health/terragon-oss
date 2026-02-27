"use server";

import { userOnlyAction } from "../lib/auth-server";
import {
  getUserFlags,
  updateUserFlags,
} from "@terragon/shared/model/user-flags";
import { db } from "@/lib/db";
import type { UserFlags } from "@terragon/shared";
import type { AIModel, SelectedAIModels } from "@terragon/agent/types";
import { RELEASE_NOTES_VERSION } from "@/lib/constants";

export const getUserFlagsAction = userOnlyAction(
  async function getUserFlagsAction(userId: string): Promise<UserFlags | null> {
    console.log("getUserFlagsAction");
    return getUserFlags({ db, userId });
  },
  { defaultErrorMessage: "Failed to get user flags" },
);

export const updateSelectedModel = userOnlyAction(
  async function updateSelectedModel(userId: string, model: AIModel) {
    await updateUserFlags({
      db,
      userId,
      updates: {
        selectedModel: model,
      },
    });
  },
  { defaultErrorMessage: "Failed to update selected model" },
);

export const updateSelectedRepo = userOnlyAction(
  async function updateSelectedRepo(
    userId: string,
    repoFullName: string | null,
  ) {
    await updateUserFlags({
      db,
      userId,
      updates: {
        selectedRepo: repoFullName,
      },
    });
  },
  { defaultErrorMessage: "Failed to update selected repo" },
);

export const updateSelectedBranch = userOnlyAction(
  async function updateSelectedBranch(userId: string, branch: string | null) {
    await updateUserFlags({
      db,
      userId,
      updates: {
        selectedBranch: branch,
      },
    });
  },
  { defaultErrorMessage: "Failed to update selected branch" },
);

export const updateReleaseNotesLastSeen = userOnlyAction(
  async function updateReleaseNotesLastSeen(userId: string) {
    await updateUserFlags({
      db,
      userId,
      updates: {
        lastSeenReleaseNotesVersion: RELEASE_NOTES_VERSION,
      },
    });
  },
  { defaultErrorMessage: "Failed to update release notes last seen" },
);

export const updateSelectedModels = userOnlyAction(
  async function updateSelectedModels(
    userId: string,
    models: SelectedAIModels,
  ) {
    await updateUserFlags({
      db,
      userId,
      updates: {
        selectedModels: models as Record<AIModel, number>,
      },
    });
  },
  { defaultErrorMessage: "Failed to update selected models" },
);

export const updateMultiAgentMode = userOnlyAction(
  async function updateMultiAgentMode(userId: string, mode: boolean) {
    await updateUserFlags({
      db,
      userId,
      updates: {
        multiAgentMode: mode,
      },
    });
  },
  { defaultErrorMessage: "Failed to update multi agent mode" },
);

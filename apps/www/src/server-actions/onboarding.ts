"use server";

import { userOnlyAction } from "../lib/auth-server";
import { updateUserFlags } from "@leo/shared/model/user-flags";
import { db } from "@/lib/db";
import { getPostHogServer } from "@/lib/posthog-server";
import { getUserRepos } from "@/server-actions/user-repos";
import { getDefaultBranchForRepo } from "@/lib/github";
import { sendLoopsEvent, updateLoopsContact } from "@/lib/loops";
import { unwrapResult } from "@/lib/server-actions";

export const setOnboardingDone = userOnlyAction(
  async function setOnboardingDone(userId: string) {
    getPostHogServer().capture({
      distinctId: userId,
      event: "onboarding_done",
      properties: {},
    });

    // Send onboarding_completed event to Loops
    await sendLoopsEvent(userId, "onboarding_completed");

    // Update Loops contact properties
    await updateLoopsContact(userId, {
      hasCompletedOnboarding: true,
      onboardingCompletedAt: new Date().toISOString(),
    });

    // Get the user's repositories to set the first one as default
    let defaultSelectedRepo: string | undefined;
    let defaultSelectedBranch: string | undefined;
    try {
      const reposResult = unwrapResult(await getUserRepos());
      if (reposResult?.repos && reposResult.repos.length > 0) {
        // Set the first repo (which is already sorted by most recent push) as default
        const firstRepo = reposResult.repos[0];
        if (firstRepo) {
          defaultSelectedRepo = firstRepo.full_name;
          // Use the GitHub API's default_branch if available
          if (firstRepo.default_branch) {
            defaultSelectedBranch = firstRepo.default_branch;
          } else {
            defaultSelectedBranch = await getDefaultBranchForRepo({
              userId,
              repoFullName: firstRepo.full_name,
            });
          }
        }
      }
    } catch (error) {
      console.error("Failed to get default repo/branch for onboarding", error);
    }

    await updateUserFlags({
      db,
      userId,
      updates: {
        hasSeenOnboarding: true,
        ...(defaultSelectedRepo && { selectedRepo: defaultSelectedRepo }),
        ...(defaultSelectedBranch && { selectedBranch: defaultSelectedBranch }),
      },
    });
  },
  { defaultErrorMessage: "Failed to set onboarding done" },
);

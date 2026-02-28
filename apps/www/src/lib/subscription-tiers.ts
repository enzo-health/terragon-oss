import { db } from "@/lib/db";
import { getUserSettings } from "@terragon/shared/model/user";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import type { SandboxSize } from "@terragon/types/sandbox";

const productionMaxConcurrentTasks = 3;
const developmentMaxConcurrentTasks = 3;
const proMaxConcurrentTasks = 10;

export const DEFAULT_SANDBOX_SIZE: SandboxSize = "small";

// Maximum number of automations allowed per user (without unlimited feature flag)
export const DEFAULT_MAX_AUTOMATIONS = 20;

const DEFAULT_MAX_CONCURRENT_TASK_COUNT =
  process.env.NODE_ENV === "production"
    ? productionMaxConcurrentTasks
    : developmentMaxConcurrentTasks;

export const maxConcurrentTasksPerUser = DEFAULT_MAX_CONCURRENT_TASK_COUNT;

export async function getSandboxSizeForUser(
  userId: string,
): Promise<SandboxSize> {
  const [userSettings, largeSandboxSizeEnabled] = await Promise.all([
    getUserSettings({ db, userId }),
    getFeatureFlagForUser({
      db,
      userId,
      flagName: "enableLargeSandboxSize",
    }),
  ]);
  if (!largeSandboxSizeEnabled) {
    return DEFAULT_SANDBOX_SIZE;
  }

  return userSettings.sandboxSize === "large" ? "large" : DEFAULT_SANDBOX_SIZE;
}

export async function getMaxConcurrentTaskCountForUser(
  _userId: string,
): Promise<number> {
  return proMaxConcurrentTasks;
}

export async function getMaxAutomationsForUser(
  userId: string,
): Promise<number | null> {
  const hasUnlimitedFlag = await getFeatureFlagForUser({
    db,
    userId,
    flagName: "allowUnlimitedAutomations",
  });
  return hasUnlimitedFlag ? null : DEFAULT_MAX_AUTOMATIONS;
}

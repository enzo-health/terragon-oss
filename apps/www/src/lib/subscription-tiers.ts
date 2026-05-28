import { db } from "@/lib/db";
import { getUserSettings } from "@terragon/shared/model/user";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import type { SandboxSize } from "@terragon/types/sandbox";

const proMaxConcurrentTasks = 10;

export const DEFAULT_SANDBOX_SIZE: SandboxSize = "large";

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

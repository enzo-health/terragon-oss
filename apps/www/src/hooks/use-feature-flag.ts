import { useAtomValue } from "jotai";
import { userFeatureFlagsAtom } from "@/atoms/user";
import { FeatureFlagName } from "@leo/shared";

export function useFeatureFlag(name: FeatureFlagName): boolean {
  const userFeatureFlags = useAtomValue(userFeatureFlagsAtom);
  return !!userFeatureFlags[name];
}

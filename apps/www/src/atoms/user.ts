import { atom, useAtom, useAtomValue } from "jotai";
import { AIAgent, AIModel } from "@leo/agent/types";
import {
  getAllAgentTypes,
  isAgentEnabledByDefault,
  modelToAgent,
} from "@leo/agent/utils";
import { User, UserSettings } from "@leo/shared";
import {
  getUserSettingsAction,
  updateUserSettingsAction,
} from "@/server-actions/user-settings";
import { toast } from "sonner";
import { useServerActionMutation } from "@/queries/server-action-helpers";

export const userAtom = atom<User | null>(null);

export const userSettingsAtom = atom<UserSettings | null>(null);

export const userFeatureFlagsAtom = atom<Record<string, boolean>>({});

export const bearerTokenAtom = atom<string | null>(null);

export interface ImpersonationInfo {
  isImpersonating: boolean;
  impersonatedBy?: string;
  impersonatedUser?: User | null;
}

export const impersonationAtom = atom<ImpersonationInfo>({
  isImpersonating: false,
});

export const useUpdateUserSettingsMutation = () => {
  const [userSettings, setUserSettings] = useAtom(userSettingsAtom);
  return useServerActionMutation({
    mutationFn: updateUserSettingsAction,
    onMutate: async (updates) => {
      if (!userSettings) {
        return;
      }
      setUserSettings({ ...userSettings, ...updates });
      return { previousUserSettings: userSettings };
    },
    onSuccess: () => {
      toast.success("Settings updated");
    },
    onError: (_, updates, context) => {
      if (userSettings && context?.previousUserSettings) {
        const userSettingsCopy = { ...userSettings };
        for (const key in updates) {
          // @ts-expect-error - we know the keys are valid
          userSettingsCopy[key as keyof UserSettings] =
            context.previousUserSettings[key as keyof UserSettings];
        }
        setUserSettings(userSettingsCopy);
      }
    },
  });
};

export const userSettingsRefetchAtom = atom(null, async (get, set) => {
  const userSettingsResult = await getUserSettingsAction();
  if (!userSettingsResult.success) {
    console.error(userSettingsResult.errorMessage);
    return;
  }
  set(userSettingsAtom, userSettingsResult.data);
});

export const allAgentsAtom = atom<AIAgent[]>((get) => {
  const featureFlags = get(userFeatureFlagsAtom);
  const allAgentTypes = getAllAgentTypes();
  return allAgentTypes.filter((agent) => {
    switch (agent) {
      case "claudeCode":
      case "codex":
      case "opencode":
      case "amp":
        return true;
      case "gemini":
        return featureFlags.geminiAgent;
      default:
        const _exhaustiveCheck: never = agent;
        console.warn("Unknown agent", _exhaustiveCheck);
        return false;
    }
  });
});

export const useAgentsToDisplay = ({
  forcedAgent,
  selectedModels,
}: {
  forcedAgent: AIAgent | null;
  selectedModels: AIModel[];
}): AIAgent[] => {
  const allAgents = useAtomValue(allAgentsAtom);
  const userSettings = useAtomValue(userSettingsAtom);
  if (forcedAgent) {
    return [forcedAgent];
  }
  const mustIncludeAgents = new Set<AIAgent>(
    selectedModels?.map(modelToAgent) || [],
  );
  return allAgents.filter((agent) => {
    if (mustIncludeAgents.has(agent)) {
      return true;
    }
    const userPreference = userSettings?.agentModelPreferences?.agents?.[agent];
    if (typeof userPreference === "boolean") {
      return userPreference;
    }
    return isAgentEnabledByDefault(agent);
  });
};

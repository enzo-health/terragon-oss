import { AIAgent, AIModel, SelectedAIModels } from "@terragon/agent/types";
import { agentToModels, modelToAgent } from "@terragon/agent/utils";
import { useAtom, useSetAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";
import {
  multiAgentModePersistedAtom,
  promptPreferencesPersistedAtom,
  selectedModelAtom,
  selectedModelsPersistedAtom,
} from "@/atoms/user-flags";
import { useFeatureFlag } from "./use-feature-flag";

export type SetSelectedModel = ({
  model,
  action,
}: {
  model: AIModel;
  action?: "toggle";
}) => void;

export function useSelectedModel({
  forcedAgent,
  forcedAgentVersion,
  initialSelectedModel,
  persistToUserFlags,
  supportsMultiAgentPromptSubmission,
}: {
  forcedAgent: AIAgent | null;
  forcedAgentVersion: number | null;
  initialSelectedModel: AIModel | null;
  persistToUserFlags?: boolean;
  supportsMultiAgentPromptSubmission?: boolean;
}): {
  isMultiAgentMode: boolean;
  setIsMultiAgentMode: (isMultiAgentMode: boolean) => void;
  selectedModel: AIModel;
  setSelectedModel: SetSelectedModel;
  selectedModels: SelectedAIModels;
} {
  const openCodeOpenAIAnthropicModel = useFeatureFlag(
    "opencodeOpenAIAnthropicModelOption",
  );
  const openCodeGemini3ProModel = useFeatureFlag(
    "opencodeGemini3ProModelOption",
  );
  const [selectedModelFromAtom, setSelectedModelFromAtom] =
    useAtom(selectedModelAtom);
  const [selectedModelsPersisted, setPersistedSelectedModels] = useAtom(
    selectedModelsPersistedAtom,
  );
  const [multiAgentModePersisted] = useAtom(multiAgentModePersistedAtom);
  const [multiAgentModeInner, setMultiAgentModeInner] = useState(
    multiAgentModePersisted,
  );
  const [selectedModelsInner, setSelectedModelsInner] =
    useState<SelectedAIModels>(() => {
      if (initialSelectedModel) {
        return { [initialSelectedModel]: 1 };
      }
      return selectedModelsPersisted;
    });

  const isMultiAgentMode = useMemo(() => {
    return supportsMultiAgentPromptSubmission ? multiAgentModeInner : false;
  }, [supportsMultiAgentPromptSubmission, multiAgentModeInner]);

  const { selectedModel, selectedModels } = useMemo(() => {
    const selectedModels: SelectedAIModels = {};
    const selectedModelsInnerEntries = Object.entries(selectedModelsInner) as [
      AIModel,
      number,
    ][];
    if (forcedAgent) {
      const validModels = agentToModels(forcedAgent, {
        agentVersion: forcedAgentVersion ?? "latest",
        enableOpenRouterOpenAIAnthropicModel: openCodeOpenAIAnthropicModel,
        enableOpencodeGemini3ProModelOption: openCodeGemini3ProModel,
      });
      for (const [model, count] of selectedModelsInnerEntries) {
        if (count > 0 && validModels.includes(model)) {
          selectedModels[model] = count;
        }
      }
    } else {
      for (const [model, count] of selectedModelsInnerEntries) {
        if (count > 0) {
          selectedModels[model] = count;
        }
      }
    }
    const selectedModelsKeys = Object.keys(selectedModels);
    const selectedModel =
      selectedModelsKeys.length > 0
        ? (selectedModelsKeys[0]! as AIModel)
        : selectedModelFromAtom;
    return { selectedModel, selectedModels };
  }, [
    selectedModelsInner,
    selectedModelFromAtom,
    forcedAgent,
    forcedAgentVersion,
    openCodeOpenAIAnthropicModel,
    openCodeGemini3ProModel,
  ]);

  const setPersistedPromptPreferences = useSetAtom(
    promptPreferencesPersistedAtom,
  );
  const setSelectedModels = useCallback(
    (models: SelectedAIModels) => {
      setSelectedModelsInner(models);
      if (persistToUserFlags) {
        void setPersistedSelectedModels(models);
      }
    },
    [persistToUserFlags, setPersistedSelectedModels],
  );

  const setSelectedModel = useCallback(
    ({ model, action }: { model: AIModel; action?: "toggle" }) => {
      if (forcedAgent && modelToAgent(model) !== forcedAgent) {
        return false;
      }
      if (!isMultiAgentMode) {
        setSelectedModelFromAtom(model);
        const newSelectedModels = { [model]: 1 };
        if (persistToUserFlags) {
          setSelectedModelsInner(newSelectedModels);
          void setPersistedPromptPreferences({
            selectedModel: model,
            selectedModels: newSelectedModels,
          });
        } else {
          setSelectedModels(newSelectedModels);
        }
        return true;
      }
      // Multi-agent mode
      const copyOfSelectedModels = { ...selectedModels };
      if (copyOfSelectedModels[model]) {
        delete copyOfSelectedModels[model];
      } else {
        copyOfSelectedModels[model] = 1;
      }
      setSelectedModels(copyOfSelectedModels);
      return true;
    },
    [
      isMultiAgentMode,
      selectedModels,
      setSelectedModelFromAtom,
      forcedAgent,
      persistToUserFlags,
      setPersistedPromptPreferences,
      setSelectedModels,
    ],
  );

  const setIsMultiAgentMode = useCallback(
    (value: boolean) => {
      const nextSelectedModels = { [selectedModel]: 1 };
      setMultiAgentModeInner(value);
      setSelectedModelsInner(nextSelectedModels);
      if (persistToUserFlags) {
        void setPersistedPromptPreferences({
          multiAgentMode: value,
          selectedModels: nextSelectedModels,
        });
      } else {
        setSelectedModels(nextSelectedModels);
      }
    },
    [
      persistToUserFlags,
      selectedModel,
      setPersistedPromptPreferences,
      setSelectedModels,
    ],
  );

  return {
    isMultiAgentMode,
    setIsMultiAgentMode,
    selectedModel,
    setSelectedModel,
    selectedModels,
  };
}

import { useAtom, useSetAtom } from "jotai";
import {
  selectedModelAtom,
  selectedModelPersistedAtom,
  multiAgentModePersistedAtom,
  selectedModelsPersistedAtom,
} from "@/atoms/user-flags";
import { AIAgent, AIModel, SelectedAIModels } from "@terragon/agent/types";
import { useCallback, useMemo, useState } from "react";
import { agentToModels, modelToAgent } from "@terragon/agent/utils";
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
  const [multiAgentModePersisted, setPersistedMultiAgentMode] = useAtom(
    multiAgentModePersistedAtom,
  );
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

  const setMultiAgentMode = useCallback(
    (value: boolean) => {
      setMultiAgentModeInner(value);
      if (persistToUserFlags) {
        setPersistedMultiAgentMode(value);
      }
    },
    [persistToUserFlags, setPersistedMultiAgentMode],
  );

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

  const setPersistedSelectedModel = useSetAtom(selectedModelPersistedAtom);
  const setSelectedModels = useCallback(
    (models: SelectedAIModels) => {
      setSelectedModelsInner(models);
      if (persistToUserFlags) {
        setPersistedSelectedModels(models);
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
        setSelectedModels(newSelectedModels);
        if (persistToUserFlags) {
          setPersistedSelectedModel(model);
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
      setPersistedSelectedModel,
      setSelectedModels,
    ],
  );

  const setIsMultiAgentMode = useCallback(
    (value: boolean) => {
      setMultiAgentMode(value);
      setSelectedModels({ [selectedModel]: 1 });
    },
    [setMultiAgentMode, selectedModel, setSelectedModels],
  );

  return {
    isMultiAgentMode,
    setIsMultiAgentMode,
    selectedModel,
    setSelectedModel,
    selectedModels,
  };
}

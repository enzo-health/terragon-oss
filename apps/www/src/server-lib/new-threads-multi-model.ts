import { SelectedAIModels } from "@terragon/agent/types";
import { AIModel } from "@terragon/agent/types";
import { type CreateThreadOptions, createNewThread } from "./new-thread-shared";

export type CreatedThreadSummary = {
  threadId: string;
  threadChatId: string;
  model: AIModel;
};

export type FailedThreadCreation = {
  model: AIModel;
  errorMessage: string;
};

export type MultiModelThreadCreationResult = {
  createdThreads: CreatedThreadSummary[];
  failedModels: FailedThreadCreation[];
};

export async function newThreadsMultiModel({
  userId,
  message,
  selectedModels,
  tolerateFailures = false,
  ...commonOptions
}: Omit<CreateThreadOptions, "sourceType"> & {
  selectedModels: SelectedAIModels;
  tolerateFailures?: boolean;
}): Promise<MultiModelThreadCreationResult> {
  const selectedModelsArr = Object.keys(selectedModels) as AIModel[];
  const additionalModelsArr = selectedModelsArr.filter(
    (model) => model !== message.model,
  );
  if (additionalModelsArr.length === 0) {
    return { createdThreads: [], failedModels: [] };
  }
  console.log("Creating additional threads for models: ", additionalModelsArr);
  const results = await Promise.allSettled(
    additionalModelsArr.map(async (model, index) => {
      return createNewThread({
        userId,
        message: { ...message, model },
        sourceType: "www-multi-agent",
        sourceMetadata: {
          type: "www-multi-agent",
          models: selectedModels,
        },
        delayMs: 1000 + index * 1000,
        ...commonOptions,
      });
    }),
  );
  const createdThreads: CreatedThreadSummary[] = [];
  const failedModels: FailedThreadCreation[] = [];

  results.forEach((result, index) => {
    const model = additionalModelsArr[index];
    if (!model) {
      return;
    }
    if (result.status === "fulfilled") {
      createdThreads.push({
        threadId: result.value.threadId,
        threadChatId: result.value.threadChatId,
        model: result.value.model,
      });
      return;
    }
    failedModels.push({
      model,
      errorMessage:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    });
  });

  if (failedModels.length > 0 && !tolerateFailures) {
    throw new Error(
      "Failed to create additional threads: " +
        failedModels.map((result) => result.errorMessage).join(", "),
    );
  }

  return { createdThreads, failedModels };
}

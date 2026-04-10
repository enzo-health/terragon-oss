import { SelectedAIModels } from "@leo/agent/types";
import { AIModel } from "@leo/agent/types";
import { type CreateThreadOptions, createNewThread } from "./new-thread-shared";

export async function newThreadsMultiModel({
  userId,
  message,
  selectedModels,
  ...commonOptions
}: Omit<CreateThreadOptions, "sourceType"> & {
  selectedModels: SelectedAIModels;
}) {
  const selectedModelsArr = Object.keys(selectedModels) as AIModel[];
  const additionalModelsArr = selectedModelsArr.filter(
    (model) => model !== message.model,
  );
  if (additionalModelsArr.length === 0) {
    return;
  }
  console.log("Creating additional threads for models: ", additionalModelsArr);
  const results = await Promise.allSettled(
    additionalModelsArr.map(async (model, index) => {
      await createNewThread({
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
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length > 0) {
    throw new Error(
      "Failed to create additional threads: " +
        failed.map((result) => result.reason).join(", "),
    );
  }
}

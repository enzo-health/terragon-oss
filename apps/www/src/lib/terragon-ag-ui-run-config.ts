import { AIModelSchema, type AIModel } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";

export type TerragonAgUiPostIntent = "append" | "resume";

export type TerragonAgUiRunConfig = {
  selectedModel: AIModel | null;
  permissionMode: DBUserMessage["permissionMode"];
  traceId: string | null;
  intent: TerragonAgUiPostIntent;
  clientSubmissionId: string | null;
};

export type TerragonAgUiRunConfigInput = {
  selectedModel: AIModel | null;
  permissionMode: DBUserMessage["permissionMode"];
  traceId?: string | null;
  intent?: TerragonAgUiPostIntent;
  clientSubmissionId?: string | null;
};

export function encodeTerragonAgUiRunConfig({
  selectedModel,
  permissionMode,
  traceId,
  intent,
  clientSubmissionId,
}: TerragonAgUiRunConfigInput): {
  terragon: Record<string, string | null>;
} {
  return {
    terragon: {
      selectedModel,
      permissionMode: permissionMode ?? null,
      traceId: traceId ?? null,
      intent: intent ?? "append",
      clientSubmissionId: clientSubmissionId ?? null,
    },
  };
}

export function decodeTerragonAgUiRunConfig(
  forwardedProps: unknown,
): TerragonAgUiRunConfig {
  const terragon = getTerragonRunConfigProps(forwardedProps);
  const selectedModelValue = terragon?.["selectedModel"];
  const permissionModeValue = terragon?.["permissionMode"];
  const traceIdValue = terragon?.["traceId"];
  const intentValue = terragon?.["intent"];
  const clientSubmissionIdValue = terragon?.["clientSubmissionId"];

  return {
    selectedModel:
      typeof selectedModelValue === "string"
        ? parseAIModelOrNull(selectedModelValue)
        : null,
    permissionMode:
      permissionModeValue === "plan" || permissionModeValue === "allowAll"
        ? permissionModeValue
        : undefined,
    traceId:
      typeof traceIdValue === "string" && traceIdValue.length > 0
        ? traceIdValue
        : null,
    intent: intentValue === "resume" ? "resume" : "append",
    clientSubmissionId:
      typeof clientSubmissionIdValue === "string" &&
      clientSubmissionIdValue.length > 0
        ? clientSubmissionIdValue
        : null,
  };
}

export function getTerragonRunConfigProps(
  forwardedProps: unknown,
): Record<string, unknown> | null {
  if (!isRecord(forwardedProps)) {
    return null;
  }

  const runConfig = forwardedProps["runConfig"];
  if (isRecord(runConfig) && isRecord(runConfig["terragon"])) {
    return runConfig["terragon"];
  }

  const terragon = forwardedProps["terragon"];
  return isRecord(terragon) ? terragon : null;
}

function parseAIModelOrNull(value: string): AIModel | null {
  const parsed = AIModelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

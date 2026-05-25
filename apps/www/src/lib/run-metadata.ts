import { AIModelSchema, type AIModel } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";

export type RunPostIntent = "append" | "resume";

export type RunMetadata = {
  selectedModel: AIModel | null;
  invalidSelectedModel: string | null;
  permissionMode: DBUserMessage["permissionMode"];
  traceId: string | null;
  intent: RunPostIntent;
  clientSubmissionId: string | null;
};

export type RunMetadataInput = {
  selectedModel: AIModel | null;
  permissionMode: DBUserMessage["permissionMode"];
  traceId?: string | null;
  intent?: RunPostIntent;
  clientSubmissionId?: string | null;
};

export function encodeRunMetadata({
  selectedModel,
  permissionMode,
  traceId,
  intent,
  clientSubmissionId,
}: RunMetadataInput): {
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

export function decodeRunMetadata(forwardedProps: unknown): RunMetadata {
  const terragon = getRunMetadataProps(forwardedProps);
  const selectedModelValue = terragon?.["selectedModel"];
  const permissionModeValue = terragon?.["permissionMode"];
  const traceIdValue = terragon?.["traceId"];
  const intentValue = terragon?.["intent"];
  const clientSubmissionIdValue = terragon?.["clientSubmissionId"];
  const selectedModelParse =
    typeof selectedModelValue === "string"
      ? parseAIModel(selectedModelValue)
      : { selectedModel: null, invalidSelectedModel: null };

  return {
    selectedModel: selectedModelParse.selectedModel,
    invalidSelectedModel: selectedModelParse.invalidSelectedModel,
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

export function getRunMetadataProps(
  forwardedProps: unknown,
): Record<string, unknown> | null {
  if (!isRecord(forwardedProps)) {
    return null;
  }

  const runConfig = forwardedProps["runConfig"];
  if (isRecord(runConfig) && isRecord(runConfig["terragon"])) {
    return runConfig["terragon"];
  }

  return null;
}

function parseAIModel(value: string): {
  selectedModel: AIModel | null;
  invalidSelectedModel: string | null;
} {
  if (value.length === 0) {
    return { selectedModel: null, invalidSelectedModel: null };
  }
  const parsed = AIModelSchema.safeParse(value);
  return parsed.success
    ? { selectedModel: parsed.data, invalidSelectedModel: null }
    : { selectedModel: null, invalidSelectedModel: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

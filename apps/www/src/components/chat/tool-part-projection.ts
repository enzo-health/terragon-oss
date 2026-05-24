import type { AIAgent } from "@terragon/agent/types";
import type {
  AllToolParts,
  DBToolCall,
  UICompletedToolPart,
  UIPart,
  UIToolLifecycleStatus,
  UIToolMcpMetadata,
  UIToolProgressChunk,
} from "@terragon/shared";

type ToolProjectionLifecycle = {
  progressChunks?: UIToolProgressChunk[];
  progressHiddenCount?: number;
  mcpMetadata?: UIToolMcpMetadata;
  toolStatus?: UIToolLifecycleStatus;
};

type PendingToolProjectionInput = {
  id: string;
  agent: AIAgent;
  name: string;
  parameters: Record<string, unknown>;
  parts?: UIPart[];
  lifecycle?: ToolProjectionLifecycle;
};

type CompletedToolProjectionInput = PendingToolProjectionInput & {
  result: string;
  isError?: boolean | null;
};

export function projectPendingToolPart({
  id,
  agent,
  name,
  parameters,
  parts = [],
  lifecycle,
}: PendingToolProjectionInput): AllToolParts {
  return {
    type: "tool",
    id,
    agent,
    name,
    parameters,
    parts,
    status: "pending",
    ...toolLifecycleFields(lifecycle),
  };
}

export function projectCompletedToolPart({
  id,
  agent,
  name,
  parameters,
  parts = [],
  lifecycle,
  result,
  isError,
}: CompletedToolProjectionInput): UICompletedToolPart<
  string,
  Record<string, unknown>
> {
  return {
    type: "tool",
    id,
    agent,
    name,
    parameters,
    parts,
    status: isError ? "error" : "completed",
    result,
    ...toolLifecycleFields(lifecycle),
  };
}

export function projectDBToolCall({
  dbToolCall,
  agent,
}: {
  dbToolCall: DBToolCall;
  agent: AIAgent;
}): AllToolParts {
  return projectPendingToolPart({
    id: dbToolCall.id,
    agent,
    name: dbToolCall.name,
    parameters: dbToolCall.parameters,
    lifecycle: {
      ...(dbToolCall.progressChunks
        ? { progressChunks: dbToolCall.progressChunks }
        : {}),
      ...(dbToolCall.mcpMetadata
        ? { mcpMetadata: dbToolCall.mcpMetadata }
        : {}),
      ...(dbToolCall.status ? { toolStatus: dbToolCall.status } : {}),
    },
  });
}

function toolLifecycleFields(
  lifecycle: ToolProjectionLifecycle | undefined,
): ToolProjectionLifecycle {
  return {
    ...(lifecycle?.progressChunks
      ? { progressChunks: lifecycle.progressChunks }
      : {}),
    ...(lifecycle?.progressHiddenCount
      ? { progressHiddenCount: lifecycle.progressHiddenCount }
      : {}),
    ...(lifecycle?.mcpMetadata ? { mcpMetadata: lifecycle.mcpMetadata } : {}),
    ...(lifecycle?.toolStatus ? { toolStatus: lifecycle.toolStatus } : {}),
  };
}

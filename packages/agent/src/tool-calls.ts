import { AIAgent } from "./types";

type ToolCall = {
  name: string;
  parameters: Record<string, any>;
  result?: string;
};

export function normalizeToolCall<T extends ToolCall>(
  _agent: AIAgent,
  toolCall: T,
): T {
  if (toolCall.name === "mcp__terry__SuggestFollowupTask") {
    return {
      ...toolCall,
      name: "SuggestFollowupTask",
      parameters: toolCall.parameters,
    };
  }

  return toolCall;
}

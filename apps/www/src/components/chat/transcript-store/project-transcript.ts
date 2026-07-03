import type { TranscriptItem, TranscriptState } from "./transcript-item";

export type NormalizedTool = {
  name: string;
  argsText: string;
  resultText: string;
  isError: boolean;
};

export type NormalizedTranscript = {
  assistantText: Record<string, string>;
  reasoning: Record<string, string>;
  tools: Record<string, NormalizedTool>;
  users: Record<string, string>;
};

export function projectTranscript(
  items: readonly TranscriptItem[],
): NormalizedTranscript {
  const assistantText: Record<string, string> = {};
  const reasoning: Record<string, string> = {};
  const tools: Record<string, NormalizedTool> = {};
  const users: Record<string, string> = {};

  for (const item of items) {
    switch (item.kind) {
      case "text":
        if (item.text.length > 0) {
          assistantText[item.messageId] = item.text;
        }
        break;
      case "reasoning":
        if (item.text.length > 0) {
          reasoning[item.messageId] = item.text;
        }
        break;
      case "tool":
        tools[item.toolCallId] = {
          name: item.name,
          argsText: item.argsText,
          resultText: item.result ?? "",
          isError: item.isError,
        };
        break;
      case "user":
        users[item.messageId] = item.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        break;
      default:
        break;
    }
  }

  return { assistantText, reasoning, tools, users };
}

export function projectTranscriptState(
  state: TranscriptState,
): NormalizedTranscript {
  return projectTranscript(state.items);
}

import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/core";
import { agUiMessagesToThreadMessages } from "./ag-ui-history-adapter";
import type { TerragonCustomPartEvent } from "./ag-ui-custom-parts";

describe("agUiMessagesToThreadMessages", () => {
  it("projects failed durable tool results as failed tool-call parts", () => {
    const messages = agUiMessagesToThreadMessages([
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool-1",
            type: "function",
            function: {
              name: "Bash",
              arguments: "{}",
            },
          },
        ],
      },
      {
        id: "tool-result-1",
        role: "tool",
        toolCallId: "tool-1",
        content: "permission denied",
        error: "permission denied",
      },
    ]);

    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.role).toBe("assistant");
    const part = message?.role === "assistant" ? message.content[0] : null;
    expect(part).toMatchObject({
      type: "tool-call",
      toolCallId: "tool-1",
      result: "permission denied",
      isError: true,
    });
  });

  it("hydrates raw data-part events with role fields as assistant-ui data parts", () => {
    const event: TerragonCustomPartEvent & { role: "assistant" } = {
      type: EventType.CUSTOM,
      role: "assistant",
      name: "terragon.data-part",
      value: {
        messageId: "assistant-live",
        partIndex: 0,
        name: "terragon.terminal",
        data: {
          type: "terminal",
          sandboxId: "sandbox-1",
          terminalId: "terminal-1",
          chunks: [],
        },
      },
    };

    const messages = agUiMessagesToThreadMessages([event]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("assistant-live");
    expect(messages[0]?.role).toBe("assistant");
    const part =
      messages[0]?.role === "assistant" ? messages[0].content[0] : undefined;
    expect(part).toMatchObject({
      type: "data",
      name: "terragon.terminal",
      data: {
        messageId: "assistant-live",
        partIndex: 0,
        name: "terragon.terminal",
        data: {
          type: "terminal",
          sandboxId: "sandbox-1",
          terminalId: "terminal-1",
          chunks: [],
        },
      },
    });
  });

  it("ignores malformed data-part events without creating transcript content", () => {
    const event: TerragonCustomPartEvent & { role: "assistant" } = {
      type: EventType.CUSTOM,
      role: "assistant",
      name: "terragon.data-part",
      value: {
        messageId: "assistant-live",
        partIndex: 0,
        data: {
          type: "diff",
          filePath: "apps/www/src/components/chat/example.ts",
          newContent: "export const value = true;\n",
          status: "applied",
        },
      },
    };

    const messages = agUiMessagesToThreadMessages([event]);

    expect(messages).toEqual([]);
  });
});

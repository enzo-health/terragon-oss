import { describe, expect, it, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import {
  hydrateAssistantHistoryMessages,
  createAssistantHistoryHydrationAdapter,
} from "./assistant-history-hydration-adapter";
import type { TerragonCustomPartEvent } from "./ag-ui-custom-parts";

describe("hydrateAssistantHistoryMessages", () => {
  it("projects failed durable tool results as failed tool-call parts", () => {
    const messages = hydrateAssistantHistoryMessages([
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

  it("dedupes repeated history messages before hydrating the runtime", () => {
    const messages = hydrateAssistantHistoryMessages([
      {
        id: "user-1",
        role: "user",
        content: "Prompt",
      },
      {
        id: "user-1",
        role: "user",
        content: "Prompt",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "Hello",
      },
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
    ]);

    expect(messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    const assistant = messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toHaveLength(2);
  });

  it("hydrates long replay histories without repeated array searches", () => {
    const history: Array<
      Parameters<typeof hydrateAssistantHistoryMessages>[0][number]
    > = [];
    for (let index = 0; index < 1_000; index += 1) {
      history.push(
        {
          id: `user-${index}`,
          role: "user",
          content: `Prompt ${index}`,
        },
        {
          id: `assistant-${index}`,
          role: "assistant",
          content: `Working ${index}`,
        },
        {
          id: `assistant-${index}`,
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: `tool-${index}`,
              type: "function",
              function: {
                name: "Bash",
                arguments: `{"command":"echo ${index}"}`,
              },
            },
          ],
        },
        {
          id: `tool-result-${index}`,
          role: "tool",
          toolCallId: `tool-${index}`,
          content: `result-${index}`,
        },
      );
    }
    const findIndexSpy = vi.spyOn(Array.prototype, "findIndex");

    try {
      const messages = hydrateAssistantHistoryMessages(history);

      expect(messages).toHaveLength(2_000);
      expect(findIndexSpy).not.toHaveBeenCalled();
      const tailAssistant = messages.at(-1);
      expect(tailAssistant?.role).toBe("assistant");
      const tailTool =
        tailAssistant?.role === "assistant"
          ? tailAssistant.content[1]
          : undefined;
      expect(tailTool).toMatchObject({
        type: "tool-call",
        toolCallId: "tool-999",
        result: "result-999",
      });
    } finally {
      findIndexSpy.mockRestore();
    }
  });

  it("keeps custom-created assistant ids from deduping later user messages", () => {
    const messages = hydrateAssistantHistoryMessages([
      {
        type: EventType.CUSTOM,
        name: "terragon.data-part",
        value: {
          messageId: "shared-id",
          partIndex: 0,
          name: "terragon.terminal",
          data: {
            type: "terminal",
            sandboxId: "sandbox-1",
            terminalId: "terminal-1",
            chunks: [],
          },
        },
      },
      {
        id: "shared-id",
        role: "user",
        content: "User message with colliding id",
      },
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
    ]);
    expect(messages[1]).toMatchObject({
      id: "shared-id",
      role: "user",
    });
  });

  it("dedupes long custom data-part streams without repeated array searches", () => {
    const history: Array<
      Parameters<typeof hydrateAssistantHistoryMessages>[0][number]
    > = [];
    for (let index = 0; index < 1_000; index += 1) {
      const value = {
        messageId: "assistant-live",
        partIndex: index,
        name: "terragon.terminal",
        data: {
          type: "terminal",
          sandboxId: "sandbox-1",
          terminalId: `terminal-${index}`,
          chunks: [],
        },
      };
      history.push(
        {
          type: EventType.CUSTOM,
          name: "terragon.data-part",
          value,
        },
        {
          type: EventType.CUSTOM,
          name: "terragon.data-part",
          value,
        },
      );
    }
    const findIndexSpy = vi.spyOn(Array.prototype, "findIndex");
    const someSpy = vi.spyOn(Array.prototype, "some");

    try {
      const messages = hydrateAssistantHistoryMessages(history);

      expect(findIndexSpy).not.toHaveBeenCalled();
      expect(someSpy).not.toHaveBeenCalled();
      expect(messages).toHaveLength(1);
      const assistant = messages[0];
      expect(assistant?.role).toBe("assistant");
      expect(
        assistant?.role === "assistant" ? assistant.content : [],
      ).toHaveLength(1_000);
    } finally {
      findIndexSpy.mockRestore();
      someSpy.mockRestore();
    }
  });

  it("marks unresolved idle-finalized tool calls as errored", async () => {
    const adapter = createAssistantHistoryHydrationAdapter(
      () => [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              function: {
                name: "Task",
                arguments: "{}",
              },
            },
          ],
        },
      ],
      { mode: "idle-finalized" },
    );

    const repository = await adapter.load();
    const message = repository.messages[0]?.message;
    expect(message?.role).toBe("assistant");
    const part = message?.role === "assistant" ? message.content[0] : null;
    expect(part).toMatchObject({
      type: "tool-call",
      toolCallId: "tool-1",
      result: "Tool call ended without a result.",
      isError: true,
    });
  });

  it("keeps unresolved active-resume tool calls pending", async () => {
    const adapter = createAssistantHistoryHydrationAdapter(
      () => [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              function: {
                name: "Task",
                arguments: "{}",
              },
            },
          ],
        },
      ],
      { mode: "active-resume" },
    );

    const repository = await adapter.load();
    const message = repository.messages[0]?.message;
    expect(message?.role).toBe("assistant");
    const part = message?.role === "assistant" ? message.content[0] : null;
    expect(part).toMatchObject({
      type: "tool-call",
      toolCallId: "tool-1",
    });
    expect(part).not.toHaveProperty("result");
    expect(repository.unstable_resume).toBe(true);
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

    const messages = hydrateAssistantHistoryMessages([event]);

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

    const messages = hydrateAssistantHistoryMessages([event]);

    expect(messages).toEqual([]);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { HttpAgent } from "@ag-ui/client";
import type {
  AppendMessage,
  ThreadAssistantMessage,
  ThreadHistoryAdapter,
  ThreadMessage,
} from "@assistant-ui/react";
import { TerragonAgUiThreadRuntimeCore } from "./terragon-ag-ui-runtime-core";

function createUserMessage(id: string, text: string): ThreadMessage {
  return {
    id,
    role: "user",
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    content: [{ type: "text", text }],
    attachments: [],
    metadata: { custom: {} },
  };
}

function createAssistantMessage(
  id: string,
  text: string,
  status: ThreadAssistantMessage["status"] = { type: "running" },
): ThreadAssistantMessage {
  return {
    id,
    role: "assistant",
    createdAt: new Date("2026-05-01T00:00:01.000Z"),
    content: [{ type: "text", text }],
    status,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {},
    },
  };
}

function createCore({
  agent,
  history,
}: {
  agent?: HttpAgent;
  history?: ThreadHistoryAdapter;
} = {}): TerragonAgUiThreadRuntimeCore {
  return new TerragonAgUiThreadRuntimeCore({
    agent:
      agent ??
      ({
        threadId: "thread-1",
        messages: [],
        runAgent: vi.fn(async () => undefined),
      } as unknown as HttpAgent),
    logger: {},
    showThinking: true,
    history,
    notifyUpdate: vi.fn(),
  });
}

describe("TerragonAgUiThreadRuntimeCore", () => {
  it("gates append until initial history load completes", async () => {
    let resolveHistory:
      | ((messages: readonly ThreadMessage[]) => void)
      | undefined;
    const historyLoaded = new Promise<readonly ThreadMessage[]>((resolve) => {
      resolveHistory = resolve;
    });
    const agent = {
      threadId: "thread-1",
      messages: [],
      runAgent: vi.fn(async () => undefined),
    } as unknown as HttpAgent;
    const history: ThreadHistoryAdapter = {
      load: async () => {
        const messages = await historyLoaded;
        return {
          messages: messages.map((message, index) => ({
            parentId: messages[index - 1]?.id ?? null,
            message,
          })),
          headId: messages.at(-1)?.id ?? null,
          unstable_resume: false,
        };
      },
      append: async () => undefined,
    };
    const core = createCore({ agent, history });
    const loadPromise = core.__internal_load("thread-1:active");
    const appendMessage: AppendMessage = {
      role: "user",
      createdAt: new Date("2026-05-01T00:00:02.000Z"),
      content: [{ type: "text", text: "new prompt" }],
      attachments: [],
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    };

    const appendPromise = core.append(appendMessage);
    await Promise.resolve();

    expect(core.getMessages()).toEqual([]);
    expect(agent.runAgent).not.toHaveBeenCalled();

    resolveHistory?.([createUserMessage("history-user", "loaded history")]);
    await loadPromise;
    await appendPromise;

    const messages = core.getMessages();
    expect(messages.slice(0, 2).map((message) => message.id)).toEqual([
      "history-user",
      messages[1]?.id,
    ]);
    expect(messages[1]?.role).toBe("user");
    expect(agent.runAgent).toHaveBeenCalledOnce();
    expect(agent.messages.map((message) => message.id)).toEqual([
      "history-user",
      messages[1]?.id,
    ]);
  });

  it("repairs an existing assistant message from a fuller external snapshot", () => {
    const fullerAssistant = createAssistantMessage("assistant-1", "hello", {
      type: "complete",
      reason: "unknown",
    });
    const core = createCore();
    core.applyExternalMessages([
      createUserMessage("user-1", "prompt"),
      createAssistantMessage("assistant-1", "hel"),
    ]);

    const mergeExternalMessages = (
      core as unknown as {
        mergeExternalMessages: (messages: readonly ThreadMessage[]) => void;
      }
    ).mergeExternalMessages.bind(core);
    mergeExternalMessages([
      createUserMessage("user-1", "prompt"),
      fullerAssistant,
    ]);

    const assistant = core.getMessages()[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(assistant?.status).toEqual({
      type: "complete",
      reason: "unknown",
    });
  });

  it("dedupes repeated external messages by id", () => {
    const core = createCore();
    core.applyExternalMessages([
      createUserMessage("user-1", "prompt"),
      createUserMessage("user-1", "prompt"),
      createAssistantMessage("assistant-1", "hel"),
      createAssistantMessage("assistant-1", "hello", {
        type: "complete",
        reason: "unknown",
      }),
    ]);

    const messages = core.getMessages();
    expect(messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    const assistant = messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(assistant?.status).toEqual({
      type: "complete",
      reason: "unknown",
    });
  });
});

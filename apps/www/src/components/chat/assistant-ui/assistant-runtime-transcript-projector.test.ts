import type {
  ThreadAssistantMessagePart,
  ThreadMessage,
} from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import { getArtifactDescriptors } from "@terragon/shared/db/artifact-descriptors";
import { describe, expect, it } from "vitest";
import { createAssistantRuntimeTranscriptProjector } from "./assistant-runtime-transcript-projector";

const createdAt = new Date(0);
const projectRuntimeTranscriptMessages = ({
  runtimeMessages,
  agent,
}: {
  runtimeMessages: readonly ThreadMessage[];
  agent: AIAgent;
}) =>
  createAssistantRuntimeTranscriptProjector()({
    runtimeMessages,
    agent,
  });

function terragonRuntimeDataPart(
  name: string,
  data: unknown,
): ThreadAssistantMessagePart {
  return {
    type: "data",
    name,
    data: {
      name,
      messageId: "assistant-1",
      partIndex: 0,
      data,
    },
  };
}

describe("projectRuntimeTranscriptMessages", () => {
  it("uses runtime messages when they project to Terragon UI messages", () => {
    const runtimeMessages: ThreadMessage[] = [
      {
        id: "user-1",
        role: "user",
        createdAt,
        content: [{ type: "text", text: "Build the thing" }],
        attachments: [],
        metadata: { custom: {} },
      },
      {
        id: "assistant-1",
        role: "assistant",
        createdAt,
        content: [
          { type: "reasoning", text: "Thinking" },
          { type: "text", text: "Done" },
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "Bash",
            args: { command: "pnpm test" },
            argsText: '{"command":"pnpm test"}',
            result: "passed",
          },
        ],
        status: { type: "complete", reason: "unknown" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];

    const projection = projectRuntimeTranscriptMessages({
      runtimeMessages,
      agent: "codex",
    });

    expect(projection.source).toBe("runtime");
    expect(projection.messages).toEqual([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Build the thing" }],
      },
      {
        id: "assistant-1",
        role: "agent",
        agent: "codex",
        parts: [
          { type: "thinking", thinking: "Thinking" },
          { type: "text", text: "Done" },
          {
            type: "tool",
            id: "tool-1",
            agent: "codex",
            name: "Bash",
            parameters: { command: "pnpm test" },
            parts: [],
            status: "completed",
            result: "passed",
          },
        ],
      },
    ]);
  });

  it("returns no transcript rows when the runtime is empty", () => {
    const projection = projectRuntimeTranscriptMessages({
      runtimeMessages: [],
      agent: "codex",
    });

    expect(projection).toEqual({
      source: "runtime",
      messages: [],
    });
  });

  it("keeps runtime ownership for rich user content without DB transcript rows", () => {
    const runtimeMessages: ThreadMessage[] = [
      {
        id: "user-1",
        role: "user",
        createdAt,
        content: [{ type: "text", text: "@repo/file.ts" }],
        attachments: [],
        metadata: { custom: {} },
      },
    ];

    const projection = projectRuntimeTranscriptMessages({
      runtimeMessages,
      agent: "codex",
    });

    expect(projection).toEqual({
      source: "runtime",
      messages: [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "@repo/file.ts" }],
        },
      ],
    });
  });

  it("projects Terragon terminal data parts from history/live runtime rows", () => {
    const runtimeMessages: ThreadMessage[] = [
      {
        id: "user-1",
        role: "user",
        createdAt,
        content: [{ type: "text", text: "Build the thing" }],
        attachments: [],
        metadata: { custom: {} },
      },
      {
        id: "assistant-1",
        role: "assistant",
        createdAt,
        content: [
          {
            type: "data",
            name: "terragon.terminal",
            data: {
              name: "terragon.terminal",
              messageId: "assistant-1",
              partIndex: 0,
              data: {
                type: "terminal",
                sandboxId: "sandbox-1",
                terminalId: "terminal-1",
                chunks: [
                  {
                    streamSeq: 1,
                    kind: "stdout",
                    text: "passed\n",
                  },
                ],
              },
            },
          },
        ],
        status: { type: "complete", reason: "unknown" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];

    const projection = projectRuntimeTranscriptMessages({
      runtimeMessages,
      agent: "codex",
    });

    expect(projection.source).toBe("runtime");
    expect(projection.messages).toEqual([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Build the thing" }],
      },
      {
        id: "assistant-1",
        role: "agent",
        agent: "codex",
        parts: [
          {
            type: "terminal",
            sandboxId: "sandbox-1",
            terminalId: "terminal-1",
            chunks: [
              {
                streamSeq: 1,
                kind: "stdout",
                text: "passed\n",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("projects product-only Terragon data parts through the runtime transcript", () => {
    const runtimeMessages: ThreadMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt,
        content: [
          terragonRuntimeDataPart("terragon.audio", {
            type: "audio",
            mimeType: "audio/wav",
            uri: "https://example.com/audio.wav",
          }),
          terragonRuntimeDataPart("terragon.resource-link", {
            type: "resource-link",
            uri: "https://example.com/report.pdf",
            name: "report.pdf",
            title: "Report",
          }),
          terragonRuntimeDataPart("terragon.auto-approval-review", {
            type: "auto-approval-review",
            reviewId: "review-1",
            targetItemId: "item-1",
            riskLevel: "low",
            action: "edit file",
            decision: "approved",
            status: "approved",
          }),
          terragonRuntimeDataPart("terragon.delegation", {
            type: "delegation",
            delegationId: "delegation-1",
            tool: "spawn",
            status: "running",
            model: null,
            senderThreadId: "thread-1",
            receiverThreadIds: ["thread-2"],
            prompt: "Review this",
            delegatedModel: "codex",
            agentsStates: { "thread-2": "running" },
          }),
        ],
        status: { type: "complete", reason: "unknown" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];

    const projection = projectRuntimeTranscriptMessages({
      runtimeMessages,
      agent: "codex",
    });

    expect(projection.messages[0]).toMatchObject({
      id: "assistant-1",
      role: "agent",
      agent: "codex",
      parts: [
        { type: "audio", uri: "https://example.com/audio.wav" },
        {
          type: "resource-link",
          uri: "https://example.com/report.pdf",
        },
        {
          type: "auto-approval-review",
          reviewId: "review-1",
          status: "approved",
        },
        {
          type: "delegation",
          delegationId: "delegation-1",
          status: "running",
        },
      ],
    });
  });

  it("rejects unwrapped Terragon data payloads", () => {
    const runtimeMessages: ThreadMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt,
        content: [
          {
            type: "data",
            name: "terragon.terminal",
            data: {
              type: "terminal",
              sandboxId: "sandbox-1",
              terminalId: "terminal-1",
              chunks: [],
            },
          },
        ],
        status: { type: "complete", reason: "unknown" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];

    const projection = projectRuntimeTranscriptMessages({
      runtimeMessages,
      agent: "codex",
    });

    expect(projection.messages).toEqual([
      {
        id: "assistant-1",
        role: "agent",
        agent: "codex",
        parts: [],
      },
    ]);
  });

  it("keeps tool-created diff payloads on the tool result path", () => {
    const runtimeMessages: ThreadMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt,
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-diff",
            toolName: "Edit",
            args: { file_path: "apps/www/src/components/chat/example.ts" },
            argsText: '{"file_path":"apps/www/src/components/chat/example.ts"}',
            result: {
              type: "diff",
              filePath: "apps/www/src/components/chat/example.ts",
              newContent: "export const value = true;\n",
              status: "applied",
            },
          },
        ],
        status: { type: "complete", reason: "unknown" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];

    const projection = projectRuntimeTranscriptMessages({
      runtimeMessages,
      agent: "codex",
    });

    expect(projection.messages).toEqual([
      {
        id: "assistant-1",
        role: "agent",
        agent: "codex",
        parts: [
          {
            type: "tool",
            id: "tool-diff",
            agent: "codex",
            name: "Edit",
            parameters: {
              file_path: "apps/www/src/components/chat/example.ts",
            },
            parts: [],
            status: "completed",
            result:
              '{"type":"diff","filePath":"apps/www/src/components/chat/example.ts","newContent":"export const value = true;\\n","status":"applied"}',
          },
        ],
      },
    ]);
    expect(projection.messages[0]?.parts[0]?.type).toBe("tool");
  });

  it("projects runtime tool artifacts into tool child parts for artifact discovery", () => {
    const runtimeMessages: ThreadMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt,
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-image",
            toolName: "Screenshot",
            args: { path: "/tmp/screenshot.png" },
            argsText: '{"path":"/tmp/screenshot.png"}',
            result: "captured screenshot",
            artifact: {
              type: "image",
              image_url: "https://example.com/output.png",
            },
          } as ThreadAssistantMessagePart,
        ],
        status: { type: "complete", reason: "unknown" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];

    const projection = projectRuntimeTranscriptMessages({
      runtimeMessages,
      agent: "codex",
    });

    const agentMessage = projection.messages[0];
    if (agentMessage?.role !== "agent") {
      throw new Error("expected agent message");
    }
    expect(agentMessage.parts).toMatchObject([
      {
        type: "tool",
        id: "tool-image",
        parts: [{ type: "image", image_url: "https://example.com/output.png" }],
      },
    ]);

    const descriptors = getArtifactDescriptors({
      messages: projection.messages,
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      kind: "media",
      part: { type: "image", image_url: "https://example.com/output.png" },
      origin: {
        type: "tool-part",
        toolCallId: "tool-image",
        toolCallName: "Screenshot",
        partType: "image",
      },
    });
  });

  it("reprojects a runtime tool when its artifact changes", () => {
    const projector = createAssistantRuntimeTranscriptProjector();
    const baseMessage: ThreadMessage = {
      id: "assistant-1",
      role: "assistant",
      createdAt,
      content: [
        {
          type: "tool-call",
          toolCallId: "tool-image",
          toolName: "Screenshot",
          args: {},
          argsText: "{}",
          result: "captured screenshot",
          artifact: {
            type: "image",
            image_url: "https://example.com/one.png",
          },
        } as ThreadAssistantMessagePart,
      ],
      status: { type: "complete", reason: "unknown" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
    const first = projector({
      runtimeMessages: [baseMessage],
      agent: "codex",
    });
    const second = projector({
      runtimeMessages: [
        {
          ...baseMessage,
          content: [
            {
              type: "tool-call",
              toolCallId: "tool-image",
              toolName: "Screenshot",
              args: {},
              argsText: "{}",
              result: "captured screenshot",
              artifact: {
                type: "image",
                image_url: "https://example.com/two.png",
              },
            } as ThreadAssistantMessagePart,
          ],
        },
      ],
      agent: "codex",
    });

    expect(second.messages[0]).not.toBe(first.messages[0]);
    expect(second.messages[0]).toMatchObject({
      parts: [
        {
          type: "tool",
          parts: [{ type: "image", image_url: "https://example.com/two.png" }],
        },
      ],
    });
  });

  it("projects runtime tool progress lifecycle fields for renderers", () => {
    const runtimeMessages: ThreadMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt,
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "Bash",
            args: { command: "pnpm test" },
            argsText: '{"command":"pnpm test"}',
            progressChunks: [{ seq: 1, text: "running tests\n" }],
            toolStatus: "in_progress",
          } as ThreadAssistantMessagePart,
        ],
        status: { type: "running" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];

    const projection = projectRuntimeTranscriptMessages({
      runtimeMessages,
      agent: "codex",
    });

    expect(projection.messages).toEqual([
      {
        id: "assistant-1",
        role: "agent",
        agent: "codex",
        parts: [
          {
            type: "tool",
            id: "tool-1",
            agent: "codex",
            name: "Bash",
            parameters: { command: "pnpm test" },
            parts: [],
            status: "pending",
            progressChunks: [{ seq: 1, text: "running tests\n" }],
            toolStatus: "in_progress",
          },
        ],
      },
    ]);
  });

  it("reprojects a pending tool when it completes with a null result", () => {
    const projector = createAssistantRuntimeTranscriptProjector();
    const assistantMessage: ThreadMessage = {
      id: "assistant-1",
      role: "assistant",
      createdAt,
      content: [
        {
          type: "tool-call",
          toolCallId: "tool-null",
          toolName: "Bash",
          args: {},
          argsText: "{}",
        },
      ],
      status: { type: "running" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
    const first = projector({
      runtimeMessages: [assistantMessage],
      agent: "codex",
    });

    const completedMessage: ThreadMessage = {
      ...assistantMessage,
      content: [
        {
          type: "tool-call",
          toolCallId: "tool-null",
          toolName: "Bash",
          args: {},
          argsText: "{}",
          result: null,
        },
      ],
    };
    const second = projector({
      runtimeMessages: [completedMessage],
      agent: "codex",
    });

    expect(second.messages[0]).not.toBe(first.messages[0]);
    expect(second.messages[0]).toMatchObject({
      parts: [
        {
          type: "tool",
          id: "tool-null",
          status: "completed",
          result: "null",
        },
      ],
    });
  });

  it("does not project diffs through the DataMessagePart path", () => {
    const runtimeMessages: ThreadMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt,
        content: [
          {
            type: "data",
            name: "terragon.diff",
            data: {
              name: "terragon.diff",
              messageId: "assistant-1",
              partIndex: 0,
              data: {
                type: "diff",
                filePath: "apps/www/src/components/chat/example.ts",
                oldContent: "export const value = false;\n",
                newContent: "export const value = true;\n",
                status: "applied",
              },
            },
          },
        ],
        status: { type: "complete", reason: "unknown" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];

    const projection = projectRuntimeTranscriptMessages({
      runtimeMessages,
      agent: "codex",
    });

    expect(projection.messages).toEqual([
      {
        id: "assistant-1",
        role: "agent",
        agent: "codex",
        parts: [],
      },
    ]);
  });

  it("does not synthesize DB transcript rows when runtime data parts are unknown", () => {
    const runtimeMessages: ThreadMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt,
        content: [
          {
            type: "data",
            name: "unknown.part",
            data: { name: "unknown.part", value: "ignored" },
          },
        ],
        status: { type: "complete", reason: "unknown" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];

    const projection = projectRuntimeTranscriptMessages({
      runtimeMessages,
      agent: "codex",
    });

    expect(projection).toEqual({
      source: "runtime",
      messages: [
        {
          id: "assistant-1",
          role: "agent",
          agent: "codex",
          parts: [],
        },
      ],
    });
  });
});

describe("createAssistantRuntimeTranscriptProjector", () => {
  it("keeps the mutable tail message responsive while reusing stable history", () => {
    const userMessage: ThreadMessage = {
      id: "user-1",
      role: "user",
      createdAt,
      content: [{ type: "text", text: "Build the thing" }],
      attachments: [],
      metadata: { custom: {} },
    };
    const assistantMessage: ThreadMessage = {
      id: "assistant-1",
      role: "assistant",
      createdAt,
      content: [{ type: "text", text: "First chunk" }],
      status: { type: "running" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
    const projector = createAssistantRuntimeTranscriptProjector();
    const first = projector({
      runtimeMessages: [userMessage, assistantMessage],
      agent: "codex",
    });

    const textPart = assistantMessage.content[0];
    if (textPart?.type !== "text") {
      throw new Error("Expected text part");
    }
    (textPart as { text: string }).text = "First chunk plus more";

    const second = projector({
      runtimeMessages: [userMessage, assistantMessage],
      agent: "codex",
    });

    expect(second.messages[0]).toBe(first.messages[0]);
    expect(second.messages[1]).toEqual({
      id: "assistant-1",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "First chunk plus more" }],
    });

    const third = projector({
      runtimeMessages: [userMessage, assistantMessage],
      agent: "codex",
    });

    expect(third.messages).toBe(second.messages);
  });

  it("detects long text edits with unchanged prefix, suffix, and length", () => {
    const projector = createAssistantRuntimeTranscriptProjector();
    const firstText = `${"a".repeat(48)}${"b".repeat(120)}${"z".repeat(96)}`;
    const secondText = `${"a".repeat(48)}${"c".repeat(120)}${"z".repeat(96)}`;
    const assistantMessage: ThreadMessage = {
      id: "assistant-long",
      role: "assistant",
      createdAt,
      content: [{ type: "text", text: firstText }],
      status: { type: "running" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
    const first = projector({
      runtimeMessages: [assistantMessage],
      agent: "codex",
    });

    const nextMessage: ThreadMessage = {
      ...assistantMessage,
      content: [{ type: "text", text: secondText }],
    };
    const second = projector({
      runtimeMessages: [nextMessage],
      agent: "codex",
    });

    expect(second.messages[0]).not.toBe(first.messages[0]);
    expect(second.messages[0]).toMatchObject({
      parts: [{ type: "text", text: secondText }],
    });
  });

  it("reprojects an immutable non-tail rich part update without touching stable neighbors", () => {
    const projector = createAssistantRuntimeTranscriptProjector();
    const userMessage: ThreadMessage = {
      id: "user-1",
      role: "user",
      createdAt,
      content: [{ type: "text", text: "Run the command" }],
      attachments: [],
      metadata: { custom: {} },
    };
    const assistantMessage: ThreadMessage = {
      id: "assistant-1",
      role: "assistant",
      createdAt,
      content: [
        {
          type: "data",
          name: "terragon.terminal",
          data: {
            name: "terragon.terminal",
            messageId: "assistant-1",
            partIndex: 0,
            data: {
              type: "terminal",
              sandboxId: "sandbox-1",
              terminalId: "terminal-1",
              chunks: [],
            },
          },
        },
      ],
      status: { type: "running" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
    const tailMessage: ThreadMessage = {
      id: "assistant-2",
      role: "assistant",
      createdAt,
      content: [{ type: "text", text: "tail" }],
      status: { type: "running" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
    const first = projector({
      runtimeMessages: [userMessage, assistantMessage, tailMessage],
      agent: "codex",
    });

    const nextAssistantMessage: ThreadMessage = {
      ...assistantMessage,
      content: [
        {
          type: "data",
          name: "terragon.terminal",
          data: {
            name: "terragon.terminal",
            messageId: "assistant-1",
            partIndex: 0,
            data: {
              type: "terminal",
              sandboxId: "sandbox-1",
              terminalId: "terminal-1",
              chunks: [
                {
                  streamSeq: 1,
                  kind: "stdout",
                  text: "done\n",
                },
              ],
            },
          },
        },
      ],
    };
    const second = projector({
      runtimeMessages: [userMessage, nextAssistantMessage, tailMessage],
      agent: "codex",
    });

    expect(second.messages[0]).toBe(first.messages[0]);
    expect(second.messages[1]).not.toBe(first.messages[1]);
    expect(second.messages[2]).toBe(first.messages[2]);
    expect(second.messages[1]).toMatchObject({
      parts: [
        {
          type: "terminal",
          chunks: [{ text: "done\n" }],
        },
      ],
    });
  });

  it("updates only the compact tail projection for large streaming histories", () => {
    const projector = createAssistantRuntimeTranscriptProjector();
    const history: ThreadMessage[] = Array.from({ length: 500 }, (_, index) =>
      index % 2 === 0
        ? {
            id: `user-${index}`,
            role: "user",
            createdAt,
            content: [{ type: "text", text: `user ${index}` }],
            attachments: [],
            metadata: { custom: {} },
          }
        : {
            id: `assistant-${index}`,
            role: "assistant",
            createdAt,
            content: [{ type: "text", text: `assistant ${index}` }],
            status: { type: "complete", reason: "unknown" },
            metadata: {
              unstable_state: null,
              unstable_annotations: [],
              unstable_data: [],
              steps: [],
              custom: {},
            },
          },
    );
    const tailMessage: ThreadMessage = {
      id: "assistant-tail",
      role: "assistant",
      createdAt,
      content: [{ type: "text", text: "first chunk" }],
      status: { type: "running" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
    const first = projector({
      runtimeMessages: [...history, tailMessage],
      agent: "codex",
    });

    const nextTailMessage: ThreadMessage = {
      ...tailMessage,
      content: [{ type: "text", text: "first chunk plus more" }],
    };
    const second = projector({
      runtimeMessages: [...history, nextTailMessage],
      agent: "codex",
    });

    expect(second.messages).toHaveLength(first.messages.length);
    for (let index = 0; index < history.length; index += 1) {
      expect(second.messages[index]).toBe(first.messages[index]);
    }
    expect(second.messages.at(-1)).not.toBe(first.messages.at(-1));
    expect(second.messages.at(-1)).toMatchObject({
      id: "assistant-tail",
      role: "agent",
      parts: [{ type: "text", text: "first chunk plus more" }],
    });
  });

  it("skips deep snapshot work for unchanged suffix messages", () => {
    const projector = createAssistantRuntimeTranscriptProjector();
    let argsReadCount = 0;
    const args = Object.defineProperty(
      {} as { readonly command: string },
      "command",
      {
        enumerable: true,
        get() {
          argsReadCount += 1;
          return "pwd";
        },
      },
    );
    const userMessage: ThreadMessage = {
      id: "user-1",
      role: "user",
      createdAt,
      content: [{ type: "text", text: "Run it" }],
      attachments: [],
      metadata: { custom: {} },
    };
    const suffixMessage: ThreadMessage = {
      id: "assistant-suffix",
      role: "assistant",
      createdAt,
      content: [
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "Bash",
          args,
          argsText: '{"command":"pwd"}',
        },
      ],
      status: { type: "running" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
    const first = projector({
      runtimeMessages: [userMessage, suffixMessage],
      agent: "codex",
    });
    const firstArgsReadCount = argsReadCount;
    expect(firstArgsReadCount).toBeGreaterThan(0);

    const changedUserMessage: ThreadMessage = {
      ...userMessage,
      content: [{ type: "text", text: "Run it again" }],
    };
    const second = projector({
      runtimeMessages: [changedUserMessage, suffixMessage],
      agent: "codex",
    });

    expect(second.messages[0]).not.toBe(first.messages[0]);
    expect(second.messages[0]).toMatchObject({
      parts: [{ type: "text", text: "Run it again" }],
    });
    expect(second.messages[1]).toBe(first.messages[1]);
    expect(argsReadCount).toBe(firstArgsReadCount);
  });

  it("re-projects only the runtime message that changed by reference", () => {
    const projector = createAssistantRuntimeTranscriptProjector();
    const userMessage: ThreadMessage = {
      id: "user-1",
      role: "user",
      createdAt,
      content: [{ type: "text", text: "Run it" }],
      attachments: [],
      metadata: { custom: {} },
    };
    const middleMessage: ThreadMessage = {
      id: "assistant-middle",
      role: "assistant",
      createdAt,
      content: [{ type: "text", text: "old middle" }],
      status: { type: "running" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
    const tailMessage: ThreadMessage = {
      id: "assistant-tail",
      role: "assistant",
      createdAt,
      content: [{ type: "text", text: "old tail" }],
      status: { type: "running" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
    const first = projector({
      runtimeMessages: [userMessage, middleMessage, tailMessage],
      agent: "codex",
    });

    const changedMiddleMessage: ThreadMessage = {
      ...middleMessage,
      content: [{ type: "text", text: "new middle" }],
    };
    const second = projector({
      runtimeMessages: [userMessage, changedMiddleMessage, tailMessage],
      agent: "codex",
    });

    expect(second.messages[0]).toBe(first.messages[0]);
    expect(second.messages[1]).not.toBe(first.messages[1]);
    expect(second.messages[1]).toMatchObject({
      id: "assistant-middle",
      parts: [{ type: "text", text: "new middle" }],
    });
    expect(second.messages[2]).toBe(first.messages[2]);
  });

  it("reuses unchanged sibling parts when one active message part changes", () => {
    const projector = createAssistantRuntimeTranscriptProjector();
    const textPart: ThreadAssistantMessagePart = {
      type: "text",
      text: "Checking",
    };
    const terminalPart: ThreadAssistantMessagePart = {
      type: "data",
      name: "terragon.terminal",
      data: {
        name: "terragon.terminal",
        messageId: "assistant-1",
        partIndex: 2,
        data: {
          type: "terminal",
          sandboxId: "sandbox-1",
          terminalId: "terminal-1",
          chunks: [{ streamSeq: 1, kind: "stdout", text: "started\n" }],
        },
      },
    };
    const firstMessage: ThreadMessage = {
      id: "assistant-1",
      role: "assistant",
      createdAt,
      content: [
        textPart,
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "Bash",
          args: { command: "pnpm test" },
          argsText: '{"command":"pnpm test"}',
          progressChunks: [{ seq: 1, text: "running\n" }],
          toolStatus: "in_progress",
        } as ThreadAssistantMessagePart,
        terminalPart,
      ],
      status: { type: "running" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };

    const first = projector({
      runtimeMessages: [firstMessage],
      agent: "codex",
    });
    const secondMessage: ThreadMessage = {
      ...firstMessage,
      content: [
        textPart,
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "Bash",
          args: { command: "pnpm test" },
          argsText: '{"command":"pnpm test"}',
          progressChunks: [
            { seq: 1, text: "running\n" },
            { seq: 2, text: "still running\n" },
          ],
          toolStatus: "in_progress",
        } as ThreadAssistantMessagePart,
        terminalPart,
      ],
    };

    const second = projector({
      runtimeMessages: [secondMessage],
      agent: "codex",
    });

    const firstAgent = first.messages[0];
    const secondAgent = second.messages[0];
    if (firstAgent?.role !== "agent" || secondAgent?.role !== "agent") {
      throw new Error("expected agent messages");
    }

    expect(secondAgent).not.toBe(firstAgent);
    expect(secondAgent.parts[0]).toBe(firstAgent.parts[0]);
    expect(secondAgent.parts[1]).not.toBe(firstAgent.parts[1]);
    expect(secondAgent.parts[2]).toBe(firstAgent.parts[2]);
  });

  it("re-projects a non-tail message changed after a tail update", () => {
    const projector = createAssistantRuntimeTranscriptProjector();
    const userMessage: ThreadMessage = {
      id: "user-1",
      role: "user",
      createdAt,
      content: [{ type: "text", text: "Run it" }],
      attachments: [],
      metadata: { custom: {} },
    };
    const assistantMessage: ThreadMessage = {
      id: "assistant-1",
      role: "assistant",
      createdAt,
      content: [{ type: "text", text: "old" }],
      status: { type: "running" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };
    const first = projector({
      runtimeMessages: [userMessage, assistantMessage],
      agent: "codex",
    });

    const tailUpdate: ThreadMessage = {
      ...assistantMessage,
      content: [{ type: "text", text: "new" }],
    };
    projector({
      runtimeMessages: [userMessage, tailUpdate],
      agent: "codex",
    });

    const nonTailUpdate: ThreadMessage = {
      ...userMessage,
      content: [{ type: "text", text: "Run it again" }],
    };
    const third = projector({
      runtimeMessages: [nonTailUpdate, tailUpdate],
      agent: "codex",
    });

    expect(third.messages[0]).not.toBe(first.messages[0]);
    expect(third.messages[0]).toMatchObject({
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Run it again" }],
    });
  });
});

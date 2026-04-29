import type { ThreadMessage } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import { projectRuntimeTranscriptMessages } from "./runtime-transcript-adapter";

const createdAt = new Date(0);

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

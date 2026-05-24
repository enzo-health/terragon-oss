import type {
  ThreadAssistantMessagePart,
  ThreadMessage,
} from "@assistant-ui/react";
import type { UIUserMessage } from "@terragon/shared";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type TerragonTranscript,
  useTerragonTranscript,
} from "./use-terragon-transcript";

const runtimeState = vi.hoisted(() => ({
  thread: {
    messages: [] as ThreadMessage[],
    isLoading: false,
  },
}));

vi.mock("@assistant-ui/react", () => ({
  useAuiState: (
    selector: (state: typeof runtimeState) => ThreadMessage[] | boolean,
  ) => selector(runtimeState),
}));

function TranscriptHarness({
  optimisticUserMessages = [],
  onTranscript,
}: {
  optimisticUserMessages?: UIUserMessage[];
  onTranscript: (transcript: TerragonTranscript) => void;
}) {
  const transcript = useTerragonTranscript({
    chatAgent: "codex",
    optimisticUserMessages,
  });
  onTranscript(transcript);
  return <div />;
}

describe("useTerragonTranscript", () => {
  beforeEach(() => {
    runtimeState.thread.messages = [];
    runtimeState.thread.isLoading = false;
  });

  it("projects assistant-ui runtime messages as the only transcript source", () => {
    runtimeState.thread.messages = [
      {
        id: "runtime-user-1",
        role: "user",
        createdAt: new Date(0),
        content: [{ type: "text", text: "Runtime transcript" }],
        attachments: [],
        metadata: { custom: {} },
      },
    ];
    const transcripts: TerragonTranscript[] = [];

    renderToStaticMarkup(
      <TranscriptHarness
        onTranscript={(nextTranscript) => {
          transcripts.push(nextTranscript);
        }}
      />,
    );

    expect(transcripts[0]?.messages).toEqual([
      {
        id: "runtime-user-1",
        role: "user",
        parts: [{ type: "text", text: "Runtime transcript" }],
      },
    ]);
  });

  it("layers optimistic user messages without duplicating matching runtime content", () => {
    runtimeState.thread.messages = [
      {
        id: "runtime-user-1",
        role: "user",
        createdAt: new Date(0),
        content: [{ type: "text", text: "Already canonical" }],
        attachments: [],
        metadata: { custom: {} },
      },
    ];
    const optimisticUserMessages: UIUserMessage[] = [
      {
        id: "optimistic-duplicate",
        role: "user",
        parts: [{ type: "text", text: "Already canonical" }],
        timestamp: new Date(0).toISOString(),
        model: null,
      },
      {
        id: "optimistic-new",
        role: "user",
        parts: [{ type: "text", text: "Queued follow-up" }],
        timestamp: new Date(1).toISOString(),
        model: null,
      },
    ];
    const transcripts: TerragonTranscript[] = [];

    renderToStaticMarkup(
      <TranscriptHarness
        optimisticUserMessages={optimisticUserMessages}
        onTranscript={(nextTranscript) => {
          transcripts.push(nextTranscript);
        }}
      />,
    );

    expect(transcripts[0]?.messages.map((message) => message.id)).toEqual([
      "runtime-user-1",
      "optimistic-new",
    ]);
  });

  it("reports hydration while the runtime is loading an empty transcript", () => {
    runtimeState.thread.isLoading = true;
    const transcripts: TerragonTranscript[] = [];

    renderToStaticMarkup(
      <TranscriptHarness
        onTranscript={(nextTranscript) => {
          transcripts.push(nextTranscript);
        }}
      />,
    );

    expect(transcripts[0]?.messages).toEqual([]);
    expect(transcripts[0]?.isRuntimeHydrating).toBe(true);
  });

  it("reports pending tool facts for working footer decisions", () => {
    runtimeState.thread.messages = [
      {
        id: "assistant-tool",
        role: "assistant",
        createdAt: new Date(0),
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "Bash",
            args: { command: "pnpm test" },
            argsText: '{"command":"pnpm test"}',
          } satisfies ThreadAssistantMessagePart,
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
    const transcripts: TerragonTranscript[] = [];

    renderToStaticMarkup(
      <TranscriptHarness
        onTranscript={(nextTranscript) => {
          transcripts.push(nextTranscript);
        }}
      />,
    );

    expect(transcripts[0]?.hasRenderableAgentParts).toBe(true);
    expect(transcripts[0]?.hasPendingToolCall).toBe(true);
  });
});

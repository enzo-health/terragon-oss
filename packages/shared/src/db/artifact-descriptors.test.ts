import { describe, expect, it } from "vitest";
import { getArtifactDescriptors } from "./artifact-descriptors";
import type { UIMessage } from "./ui-messages";

describe("getArtifactDescriptors", () => {
  it("derives descriptors from existing user message parts without cloning them", () => {
    const richTextPart = {
      type: "rich-text" as const,
      nodes: [{ type: "text" as const, text: "Build release notes" }],
    };
    const textFilePart = {
      type: "text-file" as const,
      file_url: "https://example.com/output.txt",
      filename: "output.txt",
      mime_type: "text/plain",
    };
    const messages: UIMessage[] = [
      {
        id: "user-0",
        role: "user",
        timestamp: "2024-01-01T00:00:00Z",
        model: null,
        parts: [richTextPart, textFilePart],
      },
    ];

    const descriptors = getArtifactDescriptors({ messages });

    expect(descriptors).toHaveLength(2);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual([
      "document",
      "file",
    ]);
    expect(descriptors[0]).toMatchObject({
      id: expect.stringMatching(
        /^artifact:user:2024-01-01T00:00:00Z:rich-text:/,
      ),
      title: "Document",
      summary: "Build release notes",
      origin: {
        type: "user-message-part",
        messageTimestamp: "2024-01-01T00:00:00Z",
        partType: "rich-text",
        fingerprint: expect.any(String),
      },
      updatedAt: "2024-01-01T00:00:00Z",
    });
    expect(descriptors[0]?.part).toBe(richTextPart);
    expect(descriptors[1]?.part).toBe(textFilePart);
  });

  it("recurses nested tool parts and keeps stable ids for tool-backed agent artifacts", () => {
    const richTextPart = {
      type: "rich-text" as const,
      nodes: [{ type: "text" as const, text: "Nested artifact" }],
    };
    const textFilePart = {
      type: "text-file" as const,
      file_url: "https://example.com/output.txt",
      filename: "output.txt",
      mime_type: "text/plain",
    };
    const imagePart = {
      type: "image" as const,
      image_url: "https://example.com/screenshot.png",
    };

    const buildMessage = (includeLeadingText: boolean): UIMessage => ({
      id: "agent-0",
      role: "agent",
      agent: "claudeCode",
      parts: [
        ...(includeLeadingText
          ? [{ type: "text" as const, text: "streaming status" }]
          : []),
        {
          type: "tool",
          id: "tool-outer",
          agent: "claudeCode",
          name: "Write",
          parameters: {},
          status: "completed",
          result: "done",
          parts: [
            richTextPart,
            {
              type: "tool",
              id: "tool-inner",
              agent: "claudeCode",
              name: "Capture",
              parameters: {},
              status: "completed",
              result: "done",
              parts: [textFilePart, imagePart],
            },
          ],
        },
      ],
    });

    const first = getArtifactDescriptors({ messages: [buildMessage(false)] });
    const second = getArtifactDescriptors({ messages: [buildMessage(true)] });

    expect(first).toHaveLength(3);
    expect(first.map((descriptor) => descriptor.id)).toEqual(
      second.map((descriptor) => descriptor.id),
    );
    expect(first[0]).toMatchObject({
      id: expect.stringMatching(/^artifact:tool:tool-outer:rich-text:/),
      origin: {
        type: "tool-part",
        toolCallId: "tool-outer",
        toolCallName: "Write",
        toolCallPath: ["tool-outer"],
        artifactOrdinal: 1,
        partType: "rich-text",
        fingerprint: expect.any(String),
      },
    });
    expect(first[1]).toMatchObject({
      id: expect.stringMatching(
        /^artifact:tool:tool-outer\/tool-inner:text-file:/,
      ),
      origin: {
        type: "tool-part",
        toolCallId: "tool-inner",
        toolCallName: "Capture",
        toolCallPath: ["tool-outer", "tool-inner"],
        artifactOrdinal: 1,
        partType: "text-file",
        fingerprint: expect.any(String),
      },
    });
    expect(first[2]?.part).toBe(imagePart);
  });

  it("keeps tool-backed artifact ids stable when streamed tool content changes in place", () => {
    const buildMessage = (richText: string, fileUrl: string): UIMessage => ({
      id: "agent-0",
      role: "agent",
      agent: "claudeCode",
      parts: [
        {
          type: "tool",
          id: "tool-outer",
          agent: "claudeCode",
          name: "Write",
          parameters: {},
          status: "completed",
          result: "done",
          parts: [
            {
              type: "rich-text",
              nodes: [{ type: "text", text: richText }],
            },
            {
              type: "text-file",
              file_url: fileUrl,
              filename: "output.txt",
              mime_type: "text/plain",
            },
          ],
        },
      ],
    });

    const first = getArtifactDescriptors({
      messages: [buildMessage("First revision", "https://example.com/one.txt")],
    });
    const second = getArtifactDescriptors({
      messages: [
        buildMessage("Second revision", "https://example.com/two.txt"),
      ],
    });

    expect(first.map((descriptor) => descriptor.id)).toEqual(
      second.map((descriptor) => descriptor.id),
    );
  });

  it("omits top-level streamed agent artifacts until a durable source id exists", () => {
    const messages: UIMessage[] = [
      {
        id: "agent-0",
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "rich-text",
            nodes: [{ type: "text", text: "Ephemeral draft" }],
          },
          {
            type: "image",
            image_url: "https://example.com/ephemeral.png",
          },
        ],
      },
    ];

    expect(getArtifactDescriptors({ messages })).toEqual([]);
  });

  it("creates a stable thread-level git diff descriptor keyed by thread id", () => {
    const messages: UIMessage[] = [];

    const first = getArtifactDescriptors({
      messages,
      thread: {
        id: "thread-123",
        updatedAt: "2024-01-01T00:00:00Z",
        gitDiff: "diff --git a/file.ts b/file.ts\n+hello",
        gitDiffStats: { files: 1, additions: 1, deletions: 0 },
      },
    });
    const second = getArtifactDescriptors({
      messages,
      thread: {
        id: "thread-123",
        updatedAt: "2024-01-01T00:01:00Z",
        gitDiff: "diff --git a/file.ts b/file.ts\n+hello\n+again",
        gitDiffStats: { files: 1, additions: 2, deletions: 0 },
      },
    });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: "artifact:thread:thread-123:git-diff",
      kind: "git-diff",
      title: "Current changes",
      updatedAt: "2024-01-01T00:00:00Z",
      summary: "1 file · +1 · -0",
      origin: {
        type: "thread",
        threadId: "thread-123",
        field: "gitDiff",
      },
    });
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.updatedAt).toBe("2024-01-01T00:01:00Z");
  });

  it("creates a plan artifact from an ExitPlanMode tool call with reference equality", () => {
    const exitPlanToolPart = {
      type: "tool" as const,
      id: "exit-plan-1",
      agent: "claudeCode" as const,
      name: "ExitPlanMode" as const,
      parameters: { plan: "## My Plan\n\n1. Do thing A\n2. Do thing B" },
      status: "completed" as const,
      result: "done",
      parts: [],
    };
    const messages: UIMessage[] = [
      {
        id: "agent-0",
        role: "agent",
        agent: "claudeCode",
        parts: [exitPlanToolPart],
      },
    ];

    const descriptors = getArtifactDescriptors({ messages });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: "artifact:plan:exit-plan-1",
      kind: "plan",
      title: "Plan",
      status: "ready",
      origin: {
        type: "plan-tool",
        toolCallId: "exit-plan-1",
        fingerprint: expect.any(String),
      },
      summary: "Agent plan via ExitPlanMode",
    });
    // Reference equality — the tool part object is stored directly
    expect(descriptors[0]?.part).toBe(exitPlanToolPart);
  });

  it("creates separate artifacts for multiple ExitPlanMode calls with unique IDs", () => {
    const messages: UIMessage[] = [
      {
        id: "agent-0",
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            id: "exit-plan-1",
            agent: "claudeCode",
            name: "ExitPlanMode",
            parameters: { plan: "Plan A" },
            status: "completed",
            result: "done",
            parts: [],
          },
          {
            type: "tool",
            id: "exit-plan-2",
            agent: "claudeCode",
            name: "ExitPlanMode",
            parameters: { plan: "Plan B" },
            status: "completed",
            result: "done",
            parts: [],
          },
        ],
      },
    ];

    const descriptors = getArtifactDescriptors({ messages });

    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]?.id).toBe("artifact:plan:exit-plan-1");
    expect(descriptors[1]?.id).toBe("artifact:plan:exit-plan-2");
  });

  it("creates a plan artifact from an ExitPlanMode tool call even with empty plan text", () => {
    const messages: UIMessage[] = [
      {
        id: "agent-0",
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            id: "exit-plan-empty",
            agent: "claudeCode",
            name: "ExitPlanMode",
            parameters: { plan: "" },
            status: "completed",
            result: "done",
            parts: [],
          },
        ],
      },
    ];

    const descriptors = getArtifactDescriptors({ messages });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe("plan");
  });

  it("creates a plan artifact from agent text with proposed_plan tags", () => {
    const messages: UIMessage[] = [
      {
        id: "agent-0",
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "text",
            text: "Here is my plan:\n<proposed_plan>\n# Implementation Plan\n\n## Summary\nBuild the feature\n\n## Tasks\n1. Task one\n2. Task two\n</proposed_plan>",
          },
        ],
      },
    ];

    const descriptors = getArtifactDescriptors({ messages });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      kind: "plan",
      title: "Implementation Plan",
      status: "ready",
      origin: {
        type: "tool-part",
        toolCallName: "proposed_plan",
        partType: "plan",
        fingerprint: expect.any(String),
      },
    });
    expect(descriptors[0]?.id).toMatch(/^artifact:plan:text:/);
    // Part is a UIPlanPart with the extracted text
    expect((descriptors[0]?.part as { type: string }).type).toBe("plan");
  });

  it("does not create plan artifacts from user text with proposed_plan tags", () => {
    const messages: UIMessage[] = [
      {
        id: "user-0",
        role: "user",
        model: null,
        parts: [
          {
            type: "text",
            text: "<proposed_plan>A plan</proposed_plan>",
          },
        ],
      },
    ];

    const descriptors = getArtifactDescriptors({ messages });
    expect(descriptors).toHaveLength(0);
  });

  it("turns git diff system messages into checkpoint descriptors without positional ids", () => {
    const gitDiffPart = {
      type: "git-diff" as const,
      diff: "diff --git a/file.ts b/file.ts\n+hello",
      diffStats: { files: 1, additions: 1, deletions: 0 },
      timestamp: "2024-01-01T00:00:00Z",
      description: "Checkpoint after edit",
    };
    const messages: UIMessage[] = [
      {
        id: "system-0",
        role: "system",
        message_type: "git-diff",
        parts: [gitDiffPart],
      },
    ];

    const descriptors = getArtifactDescriptors({ messages });

    expect(descriptors).toEqual([
      {
        id: "artifact:system:git-diff:2024-01-01T00:00:00Z",
        kind: "git-diff",
        title: "Checkpoint after edit",
        status: "ready",
        part: gitDiffPart,
        origin: {
          type: "system-message",
          messageType: "git-diff",
          timestamp: "2024-01-01T00:00:00Z",
          fingerprint: expect.any(String),
        },
        updatedAt: "2024-01-01T00:00:00Z",
        summary: "1 file · +1 · -0",
      },
    ]);
  });
});

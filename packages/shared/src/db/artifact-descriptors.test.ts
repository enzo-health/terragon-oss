import { describe, expect, it } from "vitest";
import type { UIMessage } from "./ui-messages";
import { getArtifactDescriptors } from "./artifact-descriptors";

describe("getArtifactDescriptors", () => {
  it("derives descriptors from existing message parts without cloning them", () => {
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
    const imagePart = {
      type: "image" as const,
      image_url: "https://example.com/screenshot.png",
    };
    const pdfPart = {
      type: "pdf" as const,
      pdf_url: "https://example.com/spec.pdf",
      filename: "spec.pdf",
    };

    const messages: UIMessage[] = [
      {
        role: "user",
        timestamp: "2024-01-01T00:00:00Z",
        model: null,
        parts: [richTextPart, textFilePart],
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [imagePart, pdfPart],
      },
    ];

    const descriptors = getArtifactDescriptors({ messages });

    expect(descriptors).toHaveLength(4);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual([
      "document",
      "file",
      "media",
      "media",
    ]);
    expect(descriptors[0]).toMatchObject({
      id: "artifact:user:2024-01-01T00:00:00Z:0:rich-text",
      title: "Document",
      summary: "Build release notes",
      origin: {
        type: "message-part",
        messageIndex: 0,
        partIndex: 0,
        messageRole: "user",
      },
      updatedAt: "2024-01-01T00:00:00Z",
    });
    expect(descriptors[0]?.part).toBe(richTextPart);
    expect(descriptors[1]?.part).toBe(textFilePart);
    expect(descriptors[2]?.part).toBe(imagePart);
    expect(descriptors[3]?.part).toBe(pdfPart);
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
    expect(second[0]?.kind).toBe("git-diff");
    expect(second[0]?.id).toBe(first[0]?.id);
    if (second[0]?.kind !== "git-diff") {
      throw new Error("Expected git diff descriptor");
    }
    expect(second[0].part.diff).toContain("again");
    expect(second[0]?.updatedAt).toBe("2024-01-01T00:01:00Z");
  });

  it("turns git diff system messages into checkpoint descriptors", () => {
    const gitDiffPart = {
      type: "git-diff" as const,
      diff: "diff --git a/file.ts b/file.ts\n+hello",
      diffStats: { files: 1, additions: 1, deletions: 0 },
      timestamp: "2024-01-01T00:00:00Z",
      description: "Checkpoint after edit",
    };
    const messages: UIMessage[] = [
      {
        role: "system",
        message_type: "git-diff",
        parts: [gitDiffPart],
      },
    ];

    const descriptors = getArtifactDescriptors({ messages });

    expect(descriptors).toEqual([
      {
        id: "artifact:system:git-diff:2024-01-01T00:00:00Z:0",
        kind: "git-diff",
        title: "Checkpoint after edit",
        status: "ready",
        part: gitDiffPart,
        origin: {
          type: "system-message",
          messageIndex: 0,
          partIndex: 0,
          messageType: "git-diff",
        },
        updatedAt: "2024-01-01T00:00:00Z",
        summary: "1 file · +1 · -0",
      },
    ]);
  });
});
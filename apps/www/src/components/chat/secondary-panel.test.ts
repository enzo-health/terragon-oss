import React from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AllToolParts } from "@leo/shared";
import type { ArtifactDescriptor } from "@leo/shared/db/artifact-descriptors";
import {
  findArtifactDescriptorForPart,
  getArtifactWorkspaceItems,
  getArtifactWorkspaceViewState,
  resolveActiveArtifactId,
} from "./secondary-panel";
import { ImagePart } from "./image-part";
import { ToolPart } from "./tool-part";

describe("secondary-panel artifact shell helpers", () => {
  it("falls back to the first artifact when the active id is missing", () => {
    expect(
      resolveActiveArtifactId({
        artifacts: [{ id: "git-diff" }, { id: "document" }],
        activeArtifactId: "missing",
      }),
    ).toBe("git-diff");
  });

  it("keeps the current artifact when it still exists", () => {
    expect(
      resolveActiveArtifactId({
        artifacts: [{ id: "git-diff" }, { id: "document" }],
        activeArtifactId: "document",
      }),
    ).toBe("document");
  });

  it("returns the correct workspace view state for empty, loading, error, and ready artifacts", () => {
    expect(getArtifactWorkspaceViewState(null)).toBe("empty");
    expect(getArtifactWorkspaceViewState({ status: "loading" })).toBe(
      "loading",
    );
    expect(getArtifactWorkspaceViewState({ status: "error" })).toBe("error");
    expect(getArtifactWorkspaceViewState({ status: "ready" })).toBe("ready");
  });

  it("creates a ready thread git diff artifact summary when diff data exists", () => {
    expect(
      getArtifactWorkspaceItems({
        messages: [],
        thread: {
          id: "thread-123",
          updatedAt: "2024-01-01T00:00:00Z",
          gitDiff: "diff --git a/file.ts b/file.ts",
          gitDiffStats: { files: 1, additions: 12, deletions: 3 },
        },
      }),
    ).toEqual([
      {
        id: "artifact:thread:thread-123:git-diff",
        kind: "git-diff",
        title: "Current changes",
        status: "ready",
        summary: "1 file · +12 · -3",
        errorMessage: undefined,
        sourceLabel: "Current thread",
        responseActionLabel: "Working tree",
      },
    ]);
  });

  it("uses an error artifact state for diffs that are too large to render", () => {
    expect(
      getArtifactWorkspaceItems({
        messages: [],
        thread: {
          id: "thread-123",
          updatedAt: "2024-01-01T00:00:00Z",
          gitDiff: "too-large",
          gitDiffStats: { files: 24, additions: 0, deletions: 0 },
        },
      }),
    ).toEqual([
      {
        id: "artifact:thread:thread-123:git-diff",
        kind: "git-diff",
        title: "Current changes",
        status: "error",
        summary: "24 files",
        errorMessage:
          "This diff is too large to render in the artifact workspace.",
        sourceLabel: "Current thread",
        responseActionLabel: "Working tree",
      },
    ]);
  });

  it("matches only the exact artifact part instance", () => {
    const originalPart = {
      type: "text-file" as const,
      file_url: "https://example.com/output.txt",
      filename: "output.txt",
      mime_type: "text/plain",
    };
    const descriptor = { id: "artifact:file:1", part: originalPart };

    expect(
      findArtifactDescriptorForPart({
        artifacts: [descriptor],
        part: originalPart,
      }),
    ).toBe(descriptor);
    // Content-equal clone should also match (handles normalizeToolCall cloning)
    expect(
      findArtifactDescriptorForPart({
        artifacts: [descriptor],
        part: { ...originalPart },
      }),
    ).toBe(descriptor);
  });

  it("creates a plan artifact summary with correct labels for ExitPlanMode origin", () => {
    const items = getArtifactWorkspaceItems({
      messages: [
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
              parameters: { plan: "My plan content" },
              status: "completed",
              result: "done",
              parts: [],
            },
          ],
        },
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "plan",
      title: "Plan",
      status: "ready",
      sourceLabel: "Agent plan",
      responseActionLabel: "Plan",
      summary: "Agent plan via ExitPlanMode",
    });
  });

  it("creates a plan artifact summary for delivery-loop plan from proposed_plan tags", () => {
    const items = getArtifactWorkspaceItems({
      messages: [
        {
          id: "agent-0",
          role: "agent",
          agent: "claudeCode",
          parts: [
            {
              type: "text",
              text: "<proposed_plan>\n# Build Feature\n\n## Summary\nDo it\n\n## Tasks\n1. Step one\n</proposed_plan>",
            },
          ],
        },
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "plan",
      title: "Implementation Plan",
      status: "ready",
      sourceLabel: "Tool output",
      responseActionLabel: "proposed_plan",
    });
  });

  it("returns no artifacts when neither the thread nor messages expose artifacts", () => {
    expect(getArtifactWorkspaceItems({ messages: [], thread: null })).toEqual(
      [],
    );
  });

  it("wires media-only tool output to the matching open-in-panel artifact action", () => {
    const imagePart = {
      type: "image" as const,
      image_url: "https://example.com/output.png",
    };
    const toolPart: Extract<AllToolParts, { name: "Read" }> = {
      type: "tool",
      agent: "claudeCode",
      id: "read-1",
      name: "Read",
      parameters: { file_path: "/tmp/output.png" },
      status: "completed",
      result: "saved image",
      parts: [imagePart],
    };
    const artifactDescriptor = {
      id: "artifact:tool:read-1:image",
      kind: "media",
      title: "Image",
      status: "ready",
      part: imagePart,
      origin: {
        type: "tool-part",
        toolCallId: "read-1",
        toolCallName: "Read",
        toolCallPath: ["read-1"],
        artifactOrdinal: 0,
        partType: "image",
        fingerprint: "image-fingerprint",
      },
    } satisfies ArtifactDescriptor;
    const onOpenArtifact = vi.fn();

    const toolTree = (ToolPart as unknown as { type: Function }).type({
      toolPart,
      artifactDescriptors: [artifactDescriptor],
      onOpenArtifact,
    });

    const renderedImagePart = findReactElementByType<{
      imageUrl: string;
      onOpenInArtifactWorkspace?: () => void;
    }>(toolTree, ImagePart);

    expect(renderedImagePart).not.toBeNull();
    expect(renderedImagePart?.props.imageUrl).toBe(imagePart.image_url);

    const openHandler = (
      renderedImagePart as React.ReactElement<{
        onOpenInArtifactWorkspace?: () => void;
      }> | null
    )?.props.onOpenInArtifactWorkspace;
    expect(openHandler).toBeTypeOf("function");

    openHandler?.();

    expect(onOpenArtifact).toHaveBeenCalledWith(artifactDescriptor.id);
  });
});

function findReactElementByType<Props = Record<string, unknown>>(
  node: ReactNode,
  type: unknown,
): React.ReactElement<Props> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findReactElementByType<Props>(child, type);
      if (match) {
        return match;
      }
    }
    return null;
  }

  if (!React.isValidElement(node)) {
    return null;
  }

  if (node.type === type) {
    return node as React.ReactElement<Props>;
  }

  return findReactElementByType<Props>(
    (node as React.ReactElement<{ children?: ReactNode }>).props.children,
    type,
  );
}

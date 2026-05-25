import type { AllToolParts } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import type { ReactNode } from "react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ImagePart } from "./image-part";
import {
  createArtifactDescriptorLookup,
  findArtifactDescriptorForPart,
  getArtifactWorkspaceItems,
  getArtifactWorkspaceViewState,
  resolveActiveArtifactId,
  resolveRepoFileTarget,
} from "./secondary-panel";
import { renderToolPartContent } from "./tool-part";

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

  it("keeps duplicate content matches ambiguous", () => {
    const firstPart = {
      type: "text-file" as const,
      file_url: "https://example.com/output.txt",
      filename: "one.txt",
      mime_type: "text/plain",
    };
    const secondPart = {
      ...firstPart,
      filename: "two.txt",
    };
    const first = { id: "artifact:file:1", part: firstPart };
    const second = { id: "artifact:file:2", part: secondPart };
    const lookup = createArtifactDescriptorLookup([first, second]);

    expect(
      findArtifactDescriptorForPart({
        artifacts: [first, second],
        lookup,
        part: { ...firstPart },
      }),
    ).toBeNull();
    expect(
      findArtifactDescriptorForPart({
        artifacts: [first, second],
        lookup,
        part: firstPart,
      }),
    ).toBe(first);
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

  it("creates a plan artifact summary from proposed_plan tags", () => {
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

    const toolTree = renderToolPartContent(toolPart, {
      threadId: "thread-1",
      threadChatId: "chat-1",
      messagesRef: { current: [] },
      isReadOnly: false,
      childThreads: [],
      githubRepoFullName: "acme/app",
      repoBaseBranchName: "main",
      branchName: "feature/test",
      artifactDescriptors: [artifactDescriptor],
      onOpenArtifact,
      renderChildToolPart: () => null,
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

describe("resolveRepoFileTarget (repo-file preview open flow)", () => {
  const workingTreeDescriptor = {
    id: "artifact:thread:thread-1:git-diff",
    kind: "git-diff" as const,
    part: {
      type: "git-diff" as const,
      diff: "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-a\n+b",
    },
    origin: {
      type: "thread" as const,
      threadId: "thread-1",
      field: "gitDiff" as const,
    },
  };

  const checkpointDescriptor = {
    id: "artifact:system:git-diff:checkpoint",
    kind: "git-diff" as const,
    part: {
      type: "git-diff" as const,
      diff: "diff --git a/src/bar.ts b/src/bar.ts\n@@ -1 +1 @@\n-x\n+y",
    },
    origin: {
      type: "system-message" as const,
      messageType: "git-diff" as const,
      fingerprint: "fp",
    },
  };

  it("returns null when no git-diff artifact exists (no dead-end fallback)", () => {
    expect(
      resolveRepoFileTarget({
        artifacts: [
          {
            id: "artifact:document:1",
            kind: "document",
            part: { type: "rich-text", nodes: [] },
            origin: {
              type: "user-message-part",
              partType: "rich-text",
              fingerprint: "fp",
            },
          },
        ],
        path: "src/foo.ts",
      }),
    ).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(
      resolveRepoFileTarget({
        artifacts: [workingTreeDescriptor],
        path: "",
      }),
    ).toBeNull();
  });

  it("opens the working-tree diff and focuses the clicked path when it is present", () => {
    expect(
      resolveRepoFileTarget({
        artifacts: [checkpointDescriptor, workingTreeDescriptor],
        path: "src/foo.ts",
      }),
    ).toEqual({
      artifactId: "artifact:thread:thread-1:git-diff",
      filePath: "src/foo.ts",
    });
  });

  it("falls back to a non-working-tree git-diff artifact that contains the path", () => {
    expect(
      resolveRepoFileTarget({
        artifacts: [workingTreeDescriptor, checkpointDescriptor],
        path: "src/bar.ts",
      }),
    ).toEqual({
      artifactId: "artifact:system:git-diff:checkpoint",
      filePath: "src/bar.ts",
    });
  });

  it("prefers the owning artifact over the working tree when both contain the path", () => {
    // Inline (chat-transcript) diffs pass the clicked part's own artifact id as
    // `preferArtifactId`. When that checkpoint contains the path, it must win
    // over the live working-tree diff that also contains it.
    const checkpointWithSharedPath = {
      ...checkpointDescriptor,
      part: {
        type: "git-diff" as const,
        diff: "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new",
      },
    };
    expect(
      resolveRepoFileTarget({
        artifacts: [workingTreeDescriptor, checkpointWithSharedPath],
        path: "src/foo.ts",
        preferArtifactId: checkpointWithSharedPath.id,
      }),
    ).toEqual({
      artifactId: checkpointWithSharedPath.id,
      filePath: "src/foo.ts",
    });
  });

  it("ignores preferArtifactId when that artifact does not contain the path", () => {
    // The preferred checkpoint only has src/bar.ts; clicking src/foo.ts must
    // fall through to the working tree rather than opening a diff without it.
    expect(
      resolveRepoFileTarget({
        artifacts: [workingTreeDescriptor, checkpointDescriptor],
        path: "src/foo.ts",
        preferArtifactId: checkpointDescriptor.id,
      }),
    ).toEqual({
      artifactId: workingTreeDescriptor.id,
      filePath: "src/foo.ts",
    });
  });

  it("returns null when the path is not a parsed file in any diff", () => {
    // The resolver matches parsed `fileName`s exactly (same as the panel's
    // focus effect), so a path that no diff actually contains resolves to
    // nothing rather than opening an artifact the panel can't focus.
    expect(
      resolveRepoFileTarget({
        artifacts: [checkpointDescriptor, workingTreeDescriptor],
        path: "src/never-seen.ts",
      }),
    ).toBeNull();
  });

  it("does not false-positive on substring or prefix-overlapping paths", () => {
    // `src/foo.ts` must not match `src/foo.ts.bak`; exact parsed-filename
    // matching prevents the old `diff.includes(path)` substring bug.
    expect(
      resolveRepoFileTarget({
        artifacts: [
          {
            id: "artifact:thread:thread-1:git-diff",
            kind: "git-diff" as const,
            part: {
              type: "git-diff" as const,
              diff: "diff --git a/src/foo.ts.bak b/src/foo.ts.bak\n@@ -1 +1 @@\n-a\n+b",
            },
            origin: {
              type: "thread" as const,
              threadId: "thread-1",
              field: "gitDiff" as const,
            },
          },
        ],
        path: "src/foo.ts",
      }),
    ).toBeNull();
  });

  it("resolves to an id that actually exists in the artifact list (no dead-end)", () => {
    // Regression: the previous implementation fabricated an
    // `artifact:repo-file:working:${path}` id that no descriptor ever
    // produced, so resolveActiveArtifactId silently fell back to artifacts[0].
    // The resolved id must be one resolveActiveArtifactId keeps.
    const target = resolveRepoFileTarget({
      artifacts: [checkpointDescriptor, workingTreeDescriptor],
      path: "src/foo.ts",
    });
    expect(target).not.toBeNull();
    const resolvedActive = resolveActiveArtifactId({
      artifacts: [checkpointDescriptor, workingTreeDescriptor],
      activeArtifactId: target?.artifactId,
    });
    expect(resolvedActive).toBe(target?.artifactId);
    // And it is NOT the first artifact (the old broken fallback behavior).
    expect(resolvedActive).not.toBe(checkpointDescriptor.id);
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

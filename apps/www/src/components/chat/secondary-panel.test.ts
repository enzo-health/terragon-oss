import { describe, expect, it } from "vitest";
import {
  createArtifactDescriptorLookup,
  findArtifactDescriptorForPart,
  getArtifactWorkspaceItems,
  getArtifactWorkspaceViewState,
  resolveActiveArtifactId,
} from "./secondary-panel";

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
});

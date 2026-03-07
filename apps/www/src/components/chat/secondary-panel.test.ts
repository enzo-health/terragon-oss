import { describe, expect, it } from "vitest";
import {
  getArtifactWorkspaceViewState,
  getThreadArtifactWorkspaceItems,
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
    expect(getArtifactWorkspaceViewState({ status: "loading" })).toBe("loading");
    expect(getArtifactWorkspaceViewState({ status: "error" })).toBe("error");
    expect(getArtifactWorkspaceViewState({ status: "ready" })).toBe("ready");
  });

  it("creates a ready git diff artifact summary when diff data exists", () => {
    expect(
      getThreadArtifactWorkspaceItems({
        gitDiff: "diff --git a/file.ts b/file.ts",
        gitDiffStats: { files: 1, additions: 12, deletions: 3 },
      }),
    ).toEqual([
      {
        id: "git-diff",
        kind: "git-diff",
        title: "Git diff",
        status: "ready",
        summary: "1 file · +12 · -3",
        errorMessage: undefined,
      },
    ]);
  });

  it("uses an error artifact state for diffs that are too large to render", () => {
    expect(
      getThreadArtifactWorkspaceItems({
        gitDiff: "too-large",
        gitDiffStats: { files: 24, additions: 0, deletions: 0 },
      }),
    ).toEqual([
      {
        id: "git-diff",
        kind: "git-diff",
        title: "Git diff",
        status: "error",
        summary: "24 files",
        errorMessage: "This diff is too large to render in the artifact workspace.",
      },
    ]);
  });

  it("returns no artifacts when the thread has no diff yet", () => {
    expect(getThreadArtifactWorkspaceItems({ gitDiff: null, gitDiffStats: null })).toEqual([]);
  });
});
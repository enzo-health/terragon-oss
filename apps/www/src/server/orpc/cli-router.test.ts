import { describe, expect, it } from "vitest";
import { resolveCreateThreadBranchNames } from "./cli-router";

describe("resolveCreateThreadBranchNames", () => {
  it("defers to repo default branch resolution when no base branch is provided", () => {
    expect(
      resolveCreateThreadBranchNames({
        repoBaseBranchName: undefined,
        createNewBranch: true,
      }),
    ).toEqual({
      baseBranchName: null,
      headBranchName: null,
    });
  });

  it("preserves an explicit base branch override", () => {
    expect(
      resolveCreateThreadBranchNames({
        repoBaseBranchName: "release/2026-03",
        createNewBranch: true,
      }),
    ).toEqual({
      baseBranchName: "release/2026-03",
      headBranchName: null,
    });
  });

  it("keeps the branch value for no-new-branch flows", () => {
    expect(
      resolveCreateThreadBranchNames({
        repoBaseBranchName: "feature/continue-here",
        createNewBranch: false,
      }),
    ).toEqual({
      baseBranchName: null,
      headBranchName: "feature/continue-here",
    });
  });
});

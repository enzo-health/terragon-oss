import assert from "node:assert/strict";
import test from "node:test";
import { resolveCreateTaskBaseBranchName } from "./create.js";

test("defaults to repo default branch for new tasks when branch is omitted", () => {
  const resolved = resolveCreateTaskBaseBranchName({
    branch: undefined,
    currentBranch: "dirty-long-lived-branch",
    createNewBranch: true,
  });

  assert.equal(resolved, undefined);
});

test("preserves an explicit branch override for new tasks", () => {
  const resolved = resolveCreateTaskBaseBranchName({
    branch: "release/2026-03",
    currentBranch: "dirty-long-lived-branch",
    createNewBranch: true,
  });

  assert.equal(resolved, "release/2026-03");
});

test("keeps the current branch when creating without a new branch", () => {
  const resolved = resolveCreateTaskBaseBranchName({
    branch: undefined,
    currentBranch: "feature/continue-here",
    createNewBranch: false,
  });

  assert.equal(resolved, "feature/continue-here");
});

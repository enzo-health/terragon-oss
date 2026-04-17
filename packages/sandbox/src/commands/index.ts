import { ISandboxSession } from "../types";
import { gitDiff } from "./git-diff";
import { diffCutoff } from "../utils";

export async function getGitDiffMaybeCutoff({
  session,
  baseBranch,
  allowCutoff,
  characterCutoff = diffCutoff,
}: {
  session: ISandboxSession;
  baseBranch?: string;
  allowCutoff: boolean;
  characterCutoff?: number;
}): Promise<"too-large" | string | null> {
  const tempPatchFile = `/tmp/patch_${Date.now()}.patch`;
  await gitDiff(session, {
    outputFile: tempPatchFile,
    baseBranch,
    characterCutoff,
  });
  const gitDiffOutput = await session.readTextFile(tempPatchFile);
  await session.runCommand(`rm ${tempPatchFile}`);
  if (!allowCutoff && gitDiffOutput.length >= characterCutoff) {
    return "too-large";
  }
  return gitDiffOutput;
}

export { gitCommitAndPushBranch } from "./git-commit-and-push";
export { getCurrentBranchName } from "./git-current-branch-name";
export { gitDiff } from "./git-diff";
export { gitDiffStats } from "./git-diff-stats";
export { gitPushWithRebase } from "./git-push-with-rebase";
export { getGitDefaultBranch } from "./git-default-branch";
export { gitPullUpstream } from "./git-pull-upstream";
export { isLocalBranchAheadOfRemote } from "./git-is-ahead";

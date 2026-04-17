import { ISandboxSession } from "../types";
import { gitPushWithRebase } from "./git-push-with-rebase";
import { getCurrentBranchName } from "./git-current-branch-name";
import { isLocalBranchAheadOfRemote } from "./git-is-ahead";
import { bashQuote, diffCutoff } from "../utils";

async function commitChangesIfNeeded({
  session,
  args,
}: {
  session: ISandboxSession;
  args: {
    githubAppName: string;
    generateCommitMessage: (gitDiff: string) => Promise<string>;
    repoRoot?: string;
  };
}): Promise<boolean> {
  const { githubAppName, generateCommitMessage, repoRoot } = args;
  const numChanges = await session.runCommand(
    "git status --porcelain | wc -l",
    { cwd: repoRoot },
  );
  if (numChanges.trim() === "0") {
    return false;
  }

  let commitMessage = "Update code";
  try {
    const tempPatchFile = `/tmp/patch_${Date.now()}.patch`;
    await session.runCommand("git add -N .", { cwd: repoRoot });
    // Use --patch-with-stat to keep file stats in the prefix in case the diff
    // gets cut off. HEAD includes both staged and unstaged changes.
    await session.runCommand(
      `git diff HEAD --no-color --patch-with-stat | head -c ${diffCutoff} > ${tempPatchFile}`,
      { cwd: repoRoot },
    );
    const gitDiffWithCutoff = await session.readTextFile(tempPatchFile);
    await session.runCommand(`rm ${tempPatchFile}`, { cwd: repoRoot });
    commitMessage = await generateCommitMessage(gitDiffWithCutoff);
  } catch (error) {
    console.error("Failed to generate commit message, using fallback:", error);
  }

  const coAuthorTrailer = githubAppName
    ? `\n\nCo-authored-by: ${githubAppName}[bot] <${githubAppName}[bot]@users.noreply.github.com>`
    : "";
  const tempCommitFile = `/tmp/commit_${Date.now()}.txt`;
  await session.writeTextFile(tempCommitFile, commitMessage + coAuthorTrailer);

  try {
    await session.runCommand("git add -A", { cwd: repoRoot });
    await session.runCommand(
      `bash -c ${bashQuote(
        `set -o pipefail; git commit -F ${tempCommitFile} | head -n 50`,
      )}`,
      { cwd: repoRoot },
    );
  } finally {
    await session.runCommand(`rm ${tempCommitFile}`, { cwd: repoRoot });
  }
  return true;
}

export async function gitCommitAndPushBranch({
  session,
  args,
}: {
  session: ISandboxSession;
  args: {
    githubAppName: string;
    baseBranch?: string;
    generateCommitMessage: (gitDiff: string) => Promise<string>;
    repoRoot?: string;
  };
}): Promise<
  | { branchName: string; errorMessage?: undefined }
  | { branchName?: undefined; errorMessage: string }
> {
  const currentBranch = await getCurrentBranchName(session, args.repoRoot);
  const hasCommitted = await commitChangesIfNeeded({ session, args });
  const shouldPush =
    hasCommitted ||
    (await isLocalBranchAheadOfRemote({
      session,
      branch: currentBranch,
      baseBranch: args.baseBranch,
      repoRoot: args.repoRoot,
    }));

  if (!shouldPush) {
    return { branchName: currentBranch };
  }

  const pushResult = await gitPushWithRebase(session, {
    branch: currentBranch,
    repoRoot: args.repoRoot,
  });
  if (pushResult.success) {
    return { branchName: currentBranch };
  }
  return { errorMessage: pushResult.message };
}

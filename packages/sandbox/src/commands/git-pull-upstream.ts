import { ISandboxSession } from "../types";

export interface GitPullUpstreamArgs {
  repoRoot?: string;
}

export async function gitPullUpstream(
  session: ISandboxSession,
  args?: GitPullUpstreamArgs,
): Promise<void> {
  console.log("[commands] gitPullUpstream", args);
  const repoRoot = args?.repoRoot;
  try {
    // Use || true to always have this return a zero exit code. In a lot of
    // cases, this would fail because there's no upstream to pull from.
    await session.runCommand("git pull --ff-only || true", {
      cwd: repoRoot,
    });
  } catch (error) {
    // Just log this and continue.
    console.log("Error pulling upstream", error);
  }
}

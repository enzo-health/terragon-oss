import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildRepoSnapshot, deleteRepoSnapshot } from "./snapshot-builder";

function getGitHubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  return execFileSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

describe("buildRepoSnapshot Daytona E2E", () => {
  it.runIf(process.env.DAYTONA_SNAPSHOT_E2E === "1")(
    "creates and deletes a real Daytona snapshot",
    async () => {
      const githubAccessToken = getGitHubToken();
      let snapshotName: string | null = null;

      try {
        const result = await buildRepoSnapshot({
          repoFullName: "octocat/Hello-World",
          baseBranch: "master",
          githubAccessToken,
          setupScript: null,
          environmentVariables: [],
          size: "small",
        });
        snapshotName = result.snapshotName;

        expect(snapshotName).toMatch(/^repo-octocat-hello-world-small-/);
      } finally {
        if (snapshotName) {
          await deleteRepoSnapshot(snapshotName);
        }
      }
    },
    20 * 60 * 1000,
  );
});

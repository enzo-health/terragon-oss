"use server";

import { userOnlyAction } from "@/lib/auth-server";
import {
  getOctokitForApp,
  getOctokitForUserOrThrow,
  parseRepoFullName,
} from "@/lib/github";
import { getGitHubApp } from "@terragon/shared/github-app";
import { Endpoints } from "@octokit/types";
import { isDevLoginEnabled } from "@/lib/auth";

export type UserRepo =
  Endpoints["GET /installation/repositories"]["response"]["data"]["repositories"][number];

function isDevLoginRepoFallbackEnabled(userId: string) {
  return isDevLoginEnabled() && userId === "dev-login-user";
}

async function getDevLoginReposFromGitHubApp(): Promise<UserRepo[]> {
  const app = getGitHubApp();
  const { data: installations } = await app.octokit.request(
    "GET /app/installations",
    {
      per_page: 100,
    },
  );
  const repoArrays = await Promise.all(
    installations.map(async (installation) => {
      const installationOctokit = await app.getInstallationOctokit(
        installation.id,
      );
      const { data } = await installationOctokit.request(
        "GET /installation/repositories",
        {
          per_page: 100,
        },
      );
      return data.repositories;
    }),
  );
  return repoArrays
    .flat()
    .filter((repo) => repo)
    .sort((a, b) => {
      const aPushedAt = a.pushed_at ? new Date(a.pushed_at).getTime() : 0;
      const bPushedAt = b.pushed_at ? new Date(b.pushed_at).getTime() : 0;
      return bPushedAt - aPushedAt;
    }) as UserRepo[];
}

export const getUserRepos = userOnlyAction(
  async function getUserRepos(userId: string) {
    const octokit = await getOctokitForUserOrThrow({ userId });
    try {
      // Try to get installations if GitHub App is configured
      const { data } =
        await octokit.rest.apps.listInstallationsForAuthenticatedUser();

      if (data.installations.length > 0) {
        // If user has app installations, get repositories from those installations in parallel
        const repoPromises = data.installations.map(async (installation) => {
          try {
            // Get all repositories accessible to the user in this installation using pagination
            const repositories = await octokit.paginate(
              octokit.rest.apps.listInstallationReposForAuthenticatedUser,
              {
                installation_id: installation.id,
                per_page: 100,
              },
            );

            return repositories;
          } catch (installationError) {
            console.warn(
              `Failed to get repos for installation ${installation.id}:`,
              installationError,
            );
            return [];
          }
        });

        const repoArrays = await Promise.all(repoPromises);
        const allRepos = repoArrays.flat();

        console.log("[getUserRepos] installations:", data.installations.length);
        console.log("[getUserRepos] allRepos:", allRepos.length);
        console.log(
          "[getUserRepos] sample permissions:",
          allRepos[0]?.permissions,
        );

        if (allRepos.length > 0) {
          const filteredRepos = allRepos
            .filter(
              (repo) =>
                repo &&
                (repo.permissions?.push === true || repo.permissions == null),
            )
            .sort((a, b) => {
              // Sort by most recently pushed (descending order)
              const aPushedAt = a.pushed_at
                ? new Date(a.pushed_at).getTime()
                : 0;
              const bPushedAt = b.pushed_at
                ? new Date(b.pushed_at).getTime()
                : 0;
              return bPushedAt - aPushedAt;
            });

          console.log("[getUserRepos] filteredRepos:", filteredRepos.length);
          return { repos: filteredRepos };
        }
      }
    } catch (appError) {
      console.error("[getUserRepos] CAUGHT ERROR:", appError);
    }
    if (isDevLoginRepoFallbackEnabled(userId)) {
      const fallbackRepos = await getDevLoginReposFromGitHubApp();
      console.log(
        "[getUserRepos] dev-login fallback repos:",
        fallbackRepos.length,
      );
      return { repos: fallbackRepos };
    }
    console.log("[getUserRepos] returning empty repos");
    return { repos: [] };
  },
  { defaultErrorMessage: "An unexpected error occurred" },
);

export const getUserRepoBranches = userOnlyAction(
  async function getUserRepoBranches(userId: string, repoFullName: string) {
    const [owner, repo] = parseRepoFullName(repoFullName);
    const octokit = await getOctokitForApp({ owner, repo });
    try {
      // Fetch repository details to get the default branch
      const [{ data: repoData }, branches] = await Promise.all([
        octokit.rest.repos.get({
          owner,
          repo,
        }),
        octokit.paginate(
          octokit.rest.repos.listBranches,
          {
            owner,
            repo,
            per_page: 100,
          },
          (response) => response.data,
        ),
      ]);
      const defaultBranch = repoData.default_branch;
      // Sort branches with default branch first, then alphabetically
      branches.sort((a, b) => {
        if (a.name === defaultBranch) return -1;
        if (b.name === defaultBranch) return 1;
        return a.name.localeCompare(b.name);
      });
      return branches;
    } catch (error) {
      console.warn(`Failed to get branches for ${repoFullName}:`, error);
      return [];
    }
  },
  { defaultErrorMessage: "An unexpected error occurred" },
);

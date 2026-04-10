import {
  getOctokitForUserOrThrow,
  getDefaultBranchForRepo,
} from "@/lib/github";
import { DB } from "@leo/shared/db";
import { getEnvironment } from "@leo/shared/model/environments";

export async function getSetupScriptFromRepo({
  db,
  userId,
  environmentId,
}: {
  db: DB;
  userId: string;
  environmentId: string;
}): Promise<string | null> {
  const environment = await getEnvironment({
    db,
    environmentId,
    userId,
  });
  if (!environment) {
    throw new Error("Environment not found");
  }
  try {
    const octokit = await getOctokitForUserOrThrow({ userId });
    const [owner, repo] = environment.repoFullName.split("/");
    if (!owner || !repo) {
      throw new Error("Invalid repository name");
    }
    const branchName = await getDefaultBranchForRepo({
      userId,
      repoFullName: environment.repoFullName,
    });
    const fetchSetupScript = async (
      path: "leo-setup.sh" | "terragon-setup.sh",
    ): Promise<string | null> => {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: branchName,
      });
      if (!("content" in data) || typeof data.content !== "string") {
        return null;
      }
      return Buffer.from(data.content, "base64").toString("utf-8");
    };

    try {
      return await fetchSetupScript("leo-setup.sh");
    } catch (error: any) {
      if (error?.status !== 404) {
        throw error;
      }
      return await fetchSetupScript("terragon-setup.sh");
    }
  } catch (error: any) {
    // If file doesn't exist, return null (not an error case)
    if (error?.status === 404) {
      return null;
    }
    // Re-throw other errors
    throw error;
  }
}

export async function getSetupScriptFromEnvironment({
  db,
  userId,
  environmentId,
}: {
  db: DB;
  userId: string;
  environmentId: string;
}): Promise<string | null> {
  const environment = await getEnvironment({
    db,
    environmentId,
    userId,
  });
  if (!environment) {
    throw new Error("Environment not found");
  }
  if (typeof environment.setupScript === "string") {
    return environment.setupScript;
  }
  return null;
}

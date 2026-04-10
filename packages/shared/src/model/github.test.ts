import { describe, expect, it, beforeEach } from "vitest";
import { getThreadForGithubPRAndUser } from "./github";
import {
  createTestUser,
  createTestThread,
  createTestGitHubPR,
} from "./test-helpers";
import { createDb } from "../db";
import { env } from "@leo/env/pkg-shared";
import { GitHubPR } from "../db/types";

const db = createDb(env.DATABASE_URL!);

describe("getThreadForGithubPRAndUser", () => {
  let pr: GitHubPR;

  beforeEach(async () => {
    pr = await createTestGitHubPR({ db });
  });

  it("should return the most recent unarchived thread for a PR and user", async () => {
    const { user } = await createTestUser({ db });
    // Create multiple threads for the same PR
    const { threadId: firstUnarchivedThreadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: pr.repoFullName,
        githubPRNumber: pr.number,
        createdAt: new Date("2023-01-03"),
        updatedAt: new Date("2023-01-03"),
      },
    });
    await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: pr.repoFullName,
        githubPRNumber: pr.number,
        createdAt: new Date("2023-01-02"),
        updatedAt: new Date("2023-01-02"),
      },
    });
    await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: pr.repoFullName,
        githubPRNumber: pr.number,
        archived: true,
        createdAt: new Date("2023-01-03"),
        updatedAt: new Date("2023-01-03"),
      },
    });
    const result = await getThreadForGithubPRAndUser({
      db,
      repoFullName: pr.repoFullName,
      prNumber: pr.number,
      userId: user.id,
    });
    expect(result).toBeDefined();
    expect(result?.id).toBe(firstUnarchivedThreadId);
    expect(result?.archived).toBe(false);
  });

  it("should return null when no threads exist for the PR and user", async () => {
    const { user } = await createTestUser({ db });
    const result = await getThreadForGithubPRAndUser({
      db,
      repoFullName: pr.repoFullName,
      prNumber: pr.number,
      userId: user.id,
    });
    expect(result).toBeNull();
  });

  it("should not return threads from other users", async () => {
    const { user: user1 } = await createTestUser({ db });
    const { user: user2 } = await createTestUser({ db });
    await createTestThread({
      db,
      userId: user1.id,
      overrides: {
        githubRepoFullName: pr.repoFullName,
        githubPRNumber: pr.number,
      },
    });
    const result = await getThreadForGithubPRAndUser({
      db,
      repoFullName: pr.repoFullName,
      prNumber: pr.number,
      userId: user2.id,
    });
    expect(result).toBeNull();
  });

  it("should not return threads from other PRs", async () => {
    const { user } = await createTestUser({ db });
    const otherPr = await createTestGitHubPR({ db });
    await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: otherPr.repoFullName,
        githubPRNumber: otherPr.number,
      },
    });
    const result = await getThreadForGithubPRAndUser({
      db,
      repoFullName: pr.repoFullName,
      prNumber: pr.number,
      userId: user.id,
    });
    expect(result).toBeNull();
  });

  it("should not return threads from other repositories", async () => {
    const { user } = await createTestUser({ db });
    // Create thread for owner/repo
    await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: pr.repoFullName,
        githubPRNumber: pr.number,
      },
    });
    // Try to get thread for owner/different-repo
    const result = await getThreadForGithubPRAndUser({
      db,
      repoFullName: "owner/different-repo",
      prNumber: pr.number,
      userId: user.id,
    });
    expect(result).toBeNull();
  });

  it("should return archived thread if it's the only one available", async () => {
    const { user } = await createTestUser({ db });
    const { threadId: archivedThreadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: pr.repoFullName,
        githubPRNumber: pr.number,
        archived: true,
      },
    });
    const result = await getThreadForGithubPRAndUser({
      db,
      repoFullName: pr.repoFullName,
      prNumber: pr.number,
      userId: user.id,
    });
    expect(result).toBeDefined();
    expect(result?.id).toBe(archivedThreadId);
    expect(result?.archived).toBe(true);
  });
});

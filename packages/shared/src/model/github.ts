import { DB } from "../db";
import * as schema from "../db/schema";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { GitHubPR } from "../db/types";
import { getThread } from "./threads";

export async function getThreadsForGithubPR({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}) {
  return await db.query.thread.findMany({
    where: and(
      eq(schema.thread.githubRepoFullName, repoFullName),
      eq(schema.thread.githubPRNumber, prNumber),
    ),
    columns: {
      id: true,
      userId: true,
      archived: true,
    },
  });
}

export async function upsertGithubPR({
  db,
  repoFullName,
  number,
  updates,
  threadId,
}: {
  db: DB;
  repoFullName: string;
  number: number;
  updates: Partial<Omit<GitHubPR, "id" | "repoFullName" | "number">>;
  threadId?: string;
}) {
  await db
    .insert(schema.githubPR)
    .values({
      repoFullName,
      number,
      threadId,
      ...updates,
    })
    .onConflictDoUpdate({
      target: [schema.githubPR.repoFullName, schema.githubPR.number],
      set: { ...updates }, // Don't update threadId on conflict
    });
}

export async function getGithubPR({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}) {
  return await db.query.githubPR.findFirst({
    where: and(
      eq(schema.githubPR.repoFullName, repoFullName),
      eq(schema.githubPR.number, prNumber),
    ),
  });
}

export async function getRecentGithubPRsForAdmin({
  db,
  limit,
}: {
  db: DB;
  limit: number;
}) {
  return await db.query.githubPR.findMany({
    orderBy: [desc(schema.githubPR.updatedAt)],
    limit,
  });
}

export async function getThreadForGithubPRAndUser({
  db,
  repoFullName,
  prNumber,
  userId,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
  userId: string;
}) {
  const threadOrNull = await db.query.thread.findFirst({
    where: and(
      eq(schema.thread.githubRepoFullName, repoFullName),
      eq(schema.thread.githubPRNumber, prNumber),
      eq(schema.thread.userId, userId),
      isNull(schema.thread.automationId),
    ),
    orderBy: [
      // Unarchived first
      asc(schema.thread.archived),
      // Then most recent first
      desc(schema.thread.updatedAt),
    ],
    columns: {
      id: true,
    },
  });
  if (!threadOrNull) {
    return null;
  }
  return await getThread({ db, threadId: threadOrNull.id, userId });
}

export async function getGithubPRForAdmin({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}) {
  return await db.query.githubPR.findFirst({
    where: and(
      eq(schema.githubPR.repoFullName, repoFullName),
      eq(schema.githubPR.number, prNumber),
    ),
  });
}

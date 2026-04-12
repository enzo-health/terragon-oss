import { DB } from "../db";
import * as schema from "../db/schema";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type {
  ReviewInsert,
  ReviewCommentInsert,
  ReviewAssignmentInsert,
  ReviewPhase,
} from "../db/types";

// ── Review CRUD ──────────────────────────────────────────────────────

export async function createReview({
  db,
  data,
}: {
  db: DB;
  data: ReviewInsert;
}) {
  const [row] = await db.insert(schema.review).values(data).returning();
  return row;
}

export async function getReview({
  db,
  reviewId,
}: {
  db: DB;
  reviewId: string;
}) {
  const reviewRow = await db.query.review.findFirst({
    where: eq(schema.review.id, reviewId),
  });
  if (!reviewRow) return null;

  const [comments, assignments] = await Promise.all([
    db.query.reviewComment.findMany({
      where: eq(schema.reviewComment.reviewId, reviewId),
    }),
    db.query.reviewAssignment.findMany({
      where: eq(schema.reviewAssignment.reviewId, reviewId),
    }),
  ]);

  return { ...reviewRow, comments, assignments };
}

export async function getReviewByPR({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}) {
  return await db.query.review.findFirst({
    where: and(
      eq(schema.review.repoFullName, repoFullName),
      eq(schema.review.prNumber, prNumber),
      ne(schema.review.phase, "complete"),
      ne(schema.review.phase, "cancelled"),
    ),
  });
}

export async function getReviewsForUser({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}) {
  const assignments = await db.query.reviewAssignment.findMany({
    where: eq(schema.reviewAssignment.userId, userId),
  });

  if (assignments.length === 0) return [];

  const reviewIds = [...new Set(assignments.map((a) => a.reviewId))];
  const reviews = await db.query.review.findMany({
    where: inArray(schema.review.id, reviewIds),
    orderBy: [desc(schema.review.updatedAt)],
  });

  // Attach the user's assignment decision to each review
  const assignmentByReviewId = new Map(assignments.map((a) => [a.reviewId, a]));

  return reviews.map((r) => ({
    ...r,
    assignment: assignmentByReviewId.get(r.id) ?? null,
  }));
}

export async function updateReview({
  db,
  reviewId,
  data,
}: {
  db: DB;
  reviewId: string;
  data: Partial<Omit<ReviewInsert, "id" | "createdAt">>;
}) {
  const [row] = await db
    .update(schema.review)
    .set(data)
    .where(eq(schema.review.id, reviewId))
    .returning();
  return row;
}

// ── Review Comments ──────────────────────────────────────────────────

export async function createReviewComment({
  db,
  data,
}: {
  db: DB;
  data: ReviewCommentInsert;
}) {
  const [row] = await db.insert(schema.reviewComment).values(data).returning();
  return row;
}

export async function updateReviewComment({
  db,
  commentId,
  data,
}: {
  db: DB;
  commentId: string;
  data: Partial<Omit<ReviewCommentInsert, "id" | "reviewId" | "createdAt">>;
}) {
  const [row] = await db
    .update(schema.reviewComment)
    .set(data)
    .where(eq(schema.reviewComment.id, commentId))
    .returning();
  return row;
}

export async function getReviewComments({
  db,
  reviewId,
  round,
}: {
  db: DB;
  reviewId: string;
  round?: number;
}) {
  const conditions = [eq(schema.reviewComment.reviewId, reviewId)];
  if (round !== undefined) {
    conditions.push(eq(schema.reviewComment.reviewRound, round));
  }
  return await db.query.reviewComment.findMany({
    where: and(...conditions),
  });
}

export async function markReviewCommentsPosted({
  db,
  commentIds,
}: {
  db: DB;
  commentIds: string[];
}) {
  if (commentIds.length === 0) return;
  await db
    .update(schema.reviewComment)
    .set({ posted: true })
    .where(inArray(schema.reviewComment.id, commentIds));
}

// ── Review Assignments ───────────────────────────────────────────────

export async function createReviewAssignment({
  db,
  data,
}: {
  db: DB;
  data: ReviewAssignmentInsert;
}) {
  const [row] = await db
    .insert(schema.reviewAssignment)
    .values(data)
    .returning();
  return row;
}

export async function updateReviewAssignment({
  db,
  assignmentId,
  data,
}: {
  db: DB;
  assignmentId: string;
  data: Partial<
    Omit<ReviewAssignmentInsert, "id" | "reviewId" | "userId" | "createdAt">
  >;
}) {
  const [row] = await db
    .update(schema.reviewAssignment)
    .set(data)
    .where(eq(schema.reviewAssignment.id, assignmentId))
    .returning();
  return row;
}

export async function getReviewAssignmentsForReview({
  db,
  reviewId,
}: {
  db: DB;
  reviewId: string;
}) {
  const assignments = await db.query.reviewAssignment.findMany({
    where: eq(schema.reviewAssignment.reviewId, reviewId),
  });

  if (assignments.length === 0) return [];

  // Attach user info
  const userIds = assignments.map((a) => a.userId);
  const users = await db.query.user.findMany({
    where: inArray(schema.user.id, userIds),
    columns: { id: true, name: true, email: true, image: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  return assignments.map((a) => ({
    ...a,
    user: userMap.get(a.userId) ?? null,
  }));
}

export async function getReviewAssignmentForUser({
  db,
  reviewId,
  userId,
}: {
  db: DB;
  reviewId: string;
  userId: string;
}) {
  return await db.query.reviewAssignment.findFirst({
    where: and(
      eq(schema.reviewAssignment.reviewId, reviewId),
      eq(schema.reviewAssignment.userId, userId),
    ),
  });
}

// ── Lifecycle helpers ────────────────────────────────────────────────

export async function completeReview({
  db,
  reviewId,
}: {
  db: DB;
  reviewId: string;
}) {
  return await updateReview({
    db,
    reviewId,
    data: { phase: "complete" as ReviewPhase },
  });
}

// ── User lookup ──────────────────────────────────────────────────────

/**
 * Find a Terragon user by their GitHub username. The `account` table stores
 * the GitHub numeric `accountId`, so we first resolve the GitHub username to
 * the account row via the user's name (best-effort) or via a direct query on
 * the github providerId + accountId.
 *
 * Since Better Auth stores the GitHub numeric ID in `account.accountId`
 * (not the username), and usernames can change, we look up by name on
 * the `user` table — which is set from the GitHub profile at signup.
 * This is an imperfect heuristic; a future improvement would store
 * `github_username` explicitly.
 */
export async function findUserByGithubUsername({
  db,
  githubUsername,
}: {
  db: DB;
  githubUsername: string;
}) {
  // The account table stores providerId="github" with accountId = numeric GitHub ID.
  // We don't have a direct username column, so we search the user table by name.
  // This is a best-effort lookup — usernames are set from GitHub profile at signup.
  const users = await db.query.user.findMany({
    where: eq(schema.user.name, githubUsername),
  });

  if (users.length === 0) return null;

  // If we found candidates, verify they have a GitHub account linked
  for (const u of users) {
    const ghAccount = await db.query.account.findFirst({
      where: and(
        eq(schema.account.userId, u.id),
        eq(schema.account.providerId, "github"),
      ),
    });
    if (ghAccount) return u;
  }

  return null;
}

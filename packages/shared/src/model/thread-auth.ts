import { sql } from "drizzle-orm";
import { DB } from "../db";
import * as schema from "../db/schema";
import { ThreadVisibility } from "../db/types";
import { eq } from "drizzle-orm";
import { getUser } from "./user";

export type AuthorizedThreadAccess = {
  ownerUserId: string;
  visibility: ThreadVisibility;
};

/**
 * Resolve whether `userId` is authorized to access the given thread.
 *
 * Policy (in order of precedence):
 * 1. Owner always has access.
 * 2. If `allowAdmin` is true and the user has the "admin" role, grant access.
 * 3. If visibility is "link", grant access to any authenticated user.
 * 4. If visibility is "repo", grant access only if the user has repo permissions
 *    (checked via `getHasRepoPermissions`).
 * 5. "private" visibility denies all non-owners.
 *
 * Returns `undefined` when access is denied or the thread does not exist.
 */
export async function getAuthorizedThreadAccess({
  db,
  threadId,
  userId,
  getHasRepoPermissions,
  allowAdmin = false,
}: {
  db: DB;
  threadId: string;
  userId: string;
  getHasRepoPermissions?: (repoFullName: string) => Promise<boolean>;
  allowAdmin?: boolean;
}): Promise<AuthorizedThreadAccess | undefined> {
  const threadResultArr = await db
    .select({
      userId: schema.thread.userId,
      githubRepoFullName: schema.thread.githubRepoFullName,
      visibility: sql<ThreadVisibility>`COALESCE(${schema.threadVisibility.visibility}, ${schema.userSettings.defaultThreadVisibility}, 'private')`,
    })
    .from(schema.thread)
    .leftJoin(
      schema.threadVisibility,
      eq(schema.threadVisibility.threadId, schema.thread.id),
    )
    .leftJoin(
      schema.userSettings,
      eq(schema.userSettings.userId, schema.thread.userId),
    )
    .where(eq(schema.thread.id, threadId));

  if (threadResultArr.length === 0) {
    return undefined;
  }

  const threadResult = threadResultArr[0]!;
  if (threadResult.userId === userId) {
    return {
      ownerUserId: threadResult.userId,
      visibility: threadResult.visibility,
    };
  }

  const user = await getUser({ db, userId });
  if (!user) {
    return undefined;
  }

  if (allowAdmin) {
    if (user.role === "admin") {
      return {
        ownerUserId: threadResult.userId,
        visibility: threadResult.visibility,
      };
    }
  }

  switch (threadResult.visibility) {
    case "private":
      return undefined;
    case "link":
      return {
        ownerUserId: threadResult.userId,
        visibility: threadResult.visibility,
      };
    case "repo":
      if (await getHasRepoPermissions?.(threadResult.githubRepoFullName)) {
        return {
          ownerUserId: threadResult.userId,
          visibility: threadResult.visibility,
        };
      }
      return undefined;
    default: {
      const _exhaustiveCheck: never = threadResult.visibility;
      throw new Error(`Invalid visibility: ${_exhaustiveCheck}`);
    }
  }
}

/**
 * Build a Drizzle SQL expression that evaluates to `true` when a row
 * is unread. Accepts `unknown` so it can be passed any column reference
 * without requiring callers to know the exact column type.
 *
 * Example:
 *   .where(sqlIsUnread(schema.threadChatReadStatus.isRead))
 */
export function sqlIsUnread(isReadColumn: unknown) {
  return sql<boolean>`NOT COALESCE(${isReadColumn}, true)`;
}

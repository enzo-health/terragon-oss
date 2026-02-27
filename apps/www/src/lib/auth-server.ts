import { auth } from "./auth";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import {
  User,
  Session,
  UserSettings,
  UserFlags,
  UserCredentials,
} from "@terragon/shared";
import { getUserSettings } from "@terragon/shared/model/user";
import { getUserFlags } from "@terragon/shared/model/user-flags";
import { cache } from "react";
import { env } from "@terragon/env/apps-www";
import { getFeatureFlagsForUser } from "@terragon/shared/model/feature-flags";
import { UserCookies } from "@/lib/cookies";
import { getUserCookies } from "./cookies-server";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import {
  ServerActionOptions,
  wrapServerActionInternal,
  UserFacingError,
  ServerActionResult,
} from "./server-actions";
import { getUserCredentials } from "@/server-lib/user-credentials";
import * as schema from "@terragon/shared/db/schema";

const initialAdminEmails = new Set(
  env.INITIAL_ADMIN_EMAILS.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0),
);

export const getSessionOrNull = cache(
  async (): Promise<{
    session: Session;
    user: User;
  } | null> => {
    const session = await auth.api.getSession({
      headers: await headers(),
    });
    if (!session?.user) {
      return null;
    }
    const user = await ensureAdminBootstrap(session.user);
    return {
      ...session,
      user,
    };
  },
);

async function ensureAdminBootstrap(user: User): Promise<User> {
  if (!user.email || user.role === "admin") {
    return user;
  }

  const normalizedEmail = user.email.trim().toLowerCase();
  if (!initialAdminEmails.has(normalizedEmail)) {
    return user;
  }

  await db
    .update(schema.user)
    .set({ role: "admin" })
    .where(eq(schema.user.id, user.id));

  return {
    ...user,
    role: "admin",
  };
}

export async function getUserIdOrNull(): Promise<User["id"] | null> {
  const session = await getSessionOrNull();
  return session?.user.id ?? null;
}

export async function getUserIdOrRedirect(): Promise<User["id"]> {
  const userId = await getUserIdOrNull();
  if (!userId) {
    redirect("/");
  }
  return userId;
}

export async function getUserIdOrNullFromDaemonToken(
  request: Pick<Request, "headers">,
): Promise<string | null> {
  const token = request.headers.get("X-Daemon-Token");
  if (!token) {
    return null;
  }
  const { valid, error, key } = await auth.api.verifyApiKey({
    body: { key: token },
  });
  const userId = key?.userId;
  if (error || !valid || !userId) {
    console.log(
      "Unauthorized",
      "error",
      error,
      "valid",
      valid,
      "userId",
      userId,
    );
    return null;
  }
  return userId;
}

export async function getUserOrNull(): Promise<User | null> {
  const session = await getSessionOrNull();
  const user = session?.user ?? null;
  if (!user) {
    return null;
  }
  return user;
}

type UserInfo = {
  user: User;
  session: Session;
  userSettings: UserSettings;
  userFlags: UserFlags;
  userCredentials: UserCredentials;
  userFeatureFlags: Record<string, boolean>;
  userCookies: UserCookies;
  impersonation: {
    isImpersonating: boolean;
    impersonatedBy?: string;
  };
};

export const getUserInfoOrNull = cache(async (): Promise<UserInfo | null> => {
  const session = await getSessionOrNull();
  if (!session) {
    return null;
  }
  const [
    userSettings,
    userFlags,
    userFeatureFlags,
    userCookies,
    userCredentials,
  ] = await Promise.all([
    getUserSettings({
      db,
      userId: session.user.id,
    }),
    getUserFlags({
      db,
      userId: session.user.id,
    }),
    getFeatureFlagsForUser({
      db,
      userId: session.user.id,
    }),
    getUserCookies(),
    getUserCredentials({
      userId: session.user.id,
    }),
  ]);
  return {
    ...session,
    userSettings,
    userFlags: getUserFlagsNormalized(userFlags),
    userFeatureFlags,
    userCookies,
    userCredentials,
    impersonation: {
      isImpersonating: !!session.session.impersonatedBy,
      impersonatedBy: session.session.impersonatedBy || undefined,
    },
  };
});

export async function getUserInfoOrRedirect(): Promise<UserInfo> {
  const userInfo = await getUserInfoOrNull();
  if (!userInfo) {
    redirect("/");
  }
  return userInfo;
}

async function getAdminUserOrNull(): Promise<User | null> {
  const user = await getUserOrNull();
  if (!user || user.role !== "admin") {
    return null;
  }
  return user;
}

export async function getAdminUserOrThrow(): Promise<User> {
  const user = await getAdminUserOrNull();
  if (!user) {
    throw new UserFacingError("Unauthorized");
  }
  return user;
}

function userOnly<T extends Array<any>, U>(
  callback: (userId: string, ...args: T) => Promise<U>,
) {
  const wrapped = async (...args: T): Promise<U> => {
    const userId = await getUserIdOrNull();
    if (!userId) {
      throw new UserFacingError("Unauthorized");
    }
    return await callback(userId, ...args);
  };
  // For testing purposes
  wrapped.userOnly = true;
  return wrapped;
}

export function userOnlyAction<T extends Array<any>, U>(
  callback: (userId: string, ...args: T) => Promise<U>,
  options: ServerActionOptions,
) {
  type UserOnlyAction = {
    (...args: T): Promise<ServerActionResult<U>>;
    userOnly?: boolean;
    wrappedServerAction?: boolean;
  };
  const userOnlyCallback = userOnly(callback);
  const userOnlyAction: UserOnlyAction = wrapServerActionInternal(
    userOnlyCallback,
    options,
  );
  userOnlyAction.userOnly = true;
  userOnlyAction.wrappedServerAction = true;
  return userOnlyAction;
}

export function adminOnly<T extends Array<any>, U>(
  callback: (adminUser: User, ...args: T) => Promise<U>,
) {
  const wrapped = async (...args: T): Promise<U> => {
    const adminUser = await getAdminUserOrThrow();
    return await callback(adminUser, ...args);
  };
  // For testing purposes
  wrapped.adminOnly = true;
  return wrapped;
}

export function adminOnlyAction<T extends Array<any>, U>(
  callback: (adminUser: User, ...args: T) => Promise<U>,
  options: ServerActionOptions,
) {
  type AdminOnlyAction = {
    (...args: T): Promise<ServerActionResult<U>>;
    adminOnly?: boolean;
    wrappedServerAction?: boolean;
  };
  const adminOnlyCallback = adminOnly(callback);
  const adminOnlyAction: AdminOnlyAction = wrapServerActionInternal(
    adminOnlyCallback,
    options,
  );
  adminOnlyAction.adminOnly = true;
  adminOnlyAction.wrappedServerAction = true;
  return adminOnlyAction;
}

export async function getCurrentUser(): Promise<User> {
  const user = await getUserOrNull();
  if (!user) {
    throw new Error("Unauthorized");
  }
  return user;
}

function getUserFlagsNormalized(userFlags: UserFlags) {
  return {
    ...userFlags,
    // In development, we want to show the debug tools by default.
    showDebugTools:
      userFlags.showDebugTools || process.env.NODE_ENV === "development",
    // Ensure isClaudeMaxSub is always defined
    isClaudeMaxSub: userFlags.isClaudeMaxSub ?? false,
    // Ensure isClaudeSub is always defined
    isClaudeSub: userFlags.isClaudeSub ?? false,
  };
}

export async function validInternalRequestOrThrow() {
  const requestHeaders = await headers();
  const secret = requestHeaders.get("X-Terragon-Secret");
  if (secret !== env.INTERNAL_SHARED_SECRET) {
    console.error("Unauthorized internal request");
    throw new Error("Unauthorized");
  }
}

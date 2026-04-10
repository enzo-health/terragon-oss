"use server";

import * as z from "zod/v4";
import { auth } from "@/lib/auth";
import { adminOnly, adminOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { User, UserFlags } from "@leo/shared";
import { grantUserCredits } from "@leo/shared/model/credits";
import { getRecentUsersForAdmin, getUser } from "@leo/shared/model/user";
import { eq } from "drizzle-orm";
import * as schema from "@leo/shared/db/schema";
import { headers } from "next/headers";
import { updateUserFlags as updateUserFlagsModel } from "@leo/shared/model/user-flags";
import { sql } from "drizzle-orm";
import { maybeTriggerCreditAutoReload } from "@/server-lib/credit-auto-reload";
import { UserFacingError } from "@/lib/server-actions";
import { forceRefreshClaudeCredentials } from "@/agent/msg/claudeCredentials";
import { forceRefreshCodexCredentials } from "@/agent/msg/codexCredentials";

export const getRecentUsers = adminOnly(async function getRecentUsers(
  _adminUser: User,
  { limit = 50 }: { limit?: number },
) {
  return await getRecentUsersForAdmin({ db, limit });
});

export const changeUserRole = adminOnly(async function changeUserRole(
  adminUser: User,
  userId: string,
  role: "admin" | "user",
) {
  console.log("changeUserRole", userId, role);
  if (adminUser.id === userId && role !== "admin") {
    throw new Error("Cannot remove yourself from admin role");
  }
  await auth.api.setRole({
    headers: await headers(),
    body: {
      userId,
      role,
    },
  });
});

export const searchUsers = adminOnly(async function searchUsers(
  adminUser: User,
  query: string,
) {
  console.log("searchUsers", query);
  // If is uuid, try to find the exact user
  if (z.string().uuid().safeParse(query).success) {
    const userOrNull = await getUser({ db, userId: query });
    if (userOrNull) {
      return [userOrNull];
    }
  }
  const users = await auth.api.listUsers({
    headers: await headers(),
    query: {
      limit: 10,
      searchOperator: "contains",
      searchField: "email",
      searchValue: query,
    },
  });
  return users.users;
});

export const banUser = adminOnly(
  async (
    adminUser: User,
    {
      userId,
      banReason,
      banExpiresIn,
    }: {
      userId: string;
      banReason?: string;
      banExpiresIn?: number;
    },
  ) => {
    console.log("banUser", userId, banReason, banExpiresIn);
    // Prevent self-ban
    if (adminUser.id === userId) {
      throw new Error("Cannot ban yourself");
    }
    try {
      await auth.api.banUser({
        headers: await headers(),
        body: {
          userId,
          banReason,
          banExpiresIn,
        },
      });

      return { success: true };
    } catch (error) {
      console.error("Failed to ban user:", error);
      throw new Error(
        error instanceof Error ? error.message : "Failed to ban user",
      );
    }
  },
);

export const unbanUser = adminOnly(async (adminUser: User, userId: string) => {
  console.log("unbanUser", userId);
  try {
    await auth.api.unbanUser({
      headers: await headers(),
      body: {
        userId,
      },
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to unban user:", error);
    throw new Error(
      error instanceof Error ? error.message : "Failed to unban user",
    );
  }
});
export const updateUserFlags = adminOnly(async function updateUserFlags(
  adminUser: User,
  targetUserId: string,
  flags: Partial<Omit<UserFlags, "id" | "userId" | "createdAt" | "updatedAt">>,
) {
  console.log("updateUserFlags", targetUserId, flags);
  await updateUserFlagsModel({ db, userId: targetUserId, updates: flags });
});

export const resetUserOnboarding = adminOnlyAction(
  async (adminUser: User, userId: string) => {
    console.log("resetUserOnboarding", userId);
    const user = await getUser({ db, userId });
    if (!user) {
      throw new UserFacingError("User not found");
    }
    await updateUserFlagsModel({
      db,
      userId: user.id,
      updates: {
        hasSeenOnboarding: false,
        selectedModel: null,
        selectedRepo: null,
        selectedBranch: null,
      },
    });
  },
  { defaultErrorMessage: "Failed to reset user onboarding" },
);

export const setShadowBanUser = adminOnly(
  async (
    adminUser: User,
    {
      userId,
      shadowBanned,
    }: {
      userId: string;
      shadowBanned: boolean;
    },
  ) => {
    console.log("setShadowBanUser", userId, shadowBanned);
    const user = await getUser({ db, userId });
    if (!user) {
      throw new Error("User not found");
    }
    await db
      .update(schema.user)
      .set({ shadowBanned })
      .where(eq(schema.user.id, userId));
    return { success: true };
  },
);

export const topUpUserCredits = adminOnly(
  async (
    adminUser: User,
    {
      userId,
      amountCents = 1_000,
      description,
    }: {
      userId: string;
      amountCents?: number;
      description?: string;
    },
  ) => {
    console.log("topUpUserCredits", userId, amountCents);
    const sanitizedAmount = Math.round(Number(amountCents));
    if (!Number.isFinite(sanitizedAmount)) {
      throw new Error("Invalid amount");
    }
    await grantUserCredits({
      db,
      grants: {
        userId,
        amountCents: sanitizedAmount,
        description: description ?? `Admin top-up by ${adminUser.email}`,
        grantType: "admin_adjustment",
        referenceId: `admin-user-id:${adminUser.id}:${Date.now()}`,
      },
    });
    return { success: true };
  },
);

function toCsvValue(value: string | null | undefined): string {
  const str = value ?? "";
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Returns a CSV string for all users. Intended for download via client.
export const exportAllUsersCsv = adminOnly(async function exportAllUsersCsv(
  _adminUser: User,
  opts?: { group?: string },
): Promise<string> {
  const group = opts?.group ?? "Founders"; // default from sample
  const users = await db
    .select({ name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    // ensure deterministic order for consistent exports
    .orderBy(sql`lower(${schema.user.name}) nulls last`, schema.user.email);

  const lines: string[] = ["Name,Email,User Group"];

  for (const u of users) {
    const name = u.name ?? "";
    lines.push(
      [name, u.email ?? "", group].map((v) => toCsvValue(v)).join(","),
    );
  }

  return lines.join("\n");
});

export const forceCreditAutoReload = adminOnly(async (adminUser: User) => {
  console.log("forceCreditAutoReload", adminUser.id);
  await maybeTriggerCreditAutoReload({
    userId: adminUser.id,
    balanceCents: 0,
  });
  return { success: true };
});

export const refreshClaudeCredentials = adminOnlyAction(
  async (
    adminUser: User,
    { userId, credentialId }: { userId: string; credentialId: string },
  ) => {
    console.log("refreshClaudeCredentials", { userId, credentialId });
    const newAccessToken = await forceRefreshClaudeCredentials({
      userId,
      credentialId,
    });
    if (!newAccessToken) {
      throw new UserFacingError(
        "No Claude credentials found or refresh token missing",
      );
    }
  },
  { defaultErrorMessage: "Failed to refresh Claude credentials" },
);

export const refreshCodexCredentials = adminOnlyAction(
  async (
    adminUser: User,
    { userId, credentialId }: { userId: string; credentialId: string },
  ) => {
    console.log("refreshCodexCredentials", { userId, credentialId });
    const newAccessToken = await forceRefreshCodexCredentials({
      userId,
      credentialId,
    });
    if (!newAccessToken) {
      throw new UserFacingError(
        "No Codex credentials found or refresh token missing",
      );
    }
  },
  { defaultErrorMessage: "Failed to refresh Codex credentials" },
);

export const deleteUser = adminOnlyAction(
  async (adminUser: User, userId: string) => {
    console.log("deleteUser", userId);

    // Prevent self-deletion
    if (adminUser.id === userId) {
      throw new UserFacingError("Cannot delete yourself");
    }

    const user = await getUser({ db, userId });
    if (!user) {
      throw new UserFacingError("User not found");
    }

    // Prevent deleting other admins
    if (user.role === "admin") {
      throw new UserFacingError("Cannot delete an admin user");
    }

    // Delete the user - cascade will handle all related tables
    await db.delete(schema.user).where(eq(schema.user.id, userId));

    console.log(`User ${userId} (${user.email}) deleted by ${adminUser.email}`);
  },
  { defaultErrorMessage: "Failed to delete user" },
);

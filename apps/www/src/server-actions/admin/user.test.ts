import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@leo/shared/model/test-helpers";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { deleteUser } from "./user";
import { getUser } from "@leo/shared/model/user";
import * as schema from "@leo/shared/db/schema";
import { eq } from "drizzle-orm";

describe("deleteUser", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.clearAllMocks();
  });

  async function createAdminUser() {
    const { user, session } = await createTestUser({ db });
    await db
      .update(schema.user)
      .set({ role: "admin" })
      .where(eq(schema.user.id, user.id));
    const updatedUser = await getUser({ db, userId: user.id });
    return { user: updatedUser!, session };
  }

  it("should delete a regular user and their associated data", async () => {
    const { session: adminSession } = await createAdminUser();
    const { user: targetUser } = await createTestUser({ db });

    // Create some associated data for the target user
    await createTestThread({
      db,
      userId: targetUser.id,
    });

    await mockLoggedInUser(adminSession);

    // Verify user exists before deletion
    const userBefore = await getUser({ db, userId: targetUser.id });
    expect(userBefore).not.toBeNull();

    // Delete the user
    const result = await deleteUser(targetUser.id);

    expect(result.success).toBe(true);

    // Verify user is deleted
    const userAfter = await getUser({ db, userId: targetUser.id });
    expect(userAfter).toBeUndefined();
  });

  it("should not allow deleting yourself", async () => {
    const { user: adminUser, session: adminSession } = await createAdminUser();

    await mockLoggedInUser(adminSession);

    const result = await deleteUser(adminUser.id);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("Cannot delete yourself");

    // Verify user still exists
    const userAfter = await getUser({ db, userId: adminUser.id });
    expect(userAfter).not.toBeNull();
  });

  it("should not allow deleting an admin user", async () => {
    const { session: adminSession } = await createAdminUser();
    const { user: otherAdmin } = await createAdminUser();

    await mockLoggedInUser(adminSession);

    const result = await deleteUser(otherAdmin.id);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("Cannot delete an admin user");

    // Verify admin still exists
    const userAfter = await getUser({ db, userId: otherAdmin.id });
    expect(userAfter).not.toBeNull();
  });

  it("should return error for non-existent user", async () => {
    const { session: adminSession } = await createAdminUser();

    await mockLoggedInUser(adminSession);

    const result = await deleteUser("non-existent-user-id");

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("User not found");
  });

  it("should cascade delete user's threads", async () => {
    const { session: adminSession } = await createAdminUser();
    const { user: targetUser } = await createTestUser({ db });

    // Create threads for the target user
    const { threadId } = await createTestThread({
      db,
      userId: targetUser.id,
    });

    await mockLoggedInUser(adminSession);

    // Verify thread exists before deletion
    const threadsBefore = await db
      .select()
      .from(schema.thread)
      .where(eq(schema.thread.id, threadId));
    expect(threadsBefore.length).toBe(1);

    // Delete the user
    const result = await deleteUser(targetUser.id);
    expect(result.success).toBe(true);

    // Verify threads are cascade deleted
    const threadsAfter = await db
      .select()
      .from(schema.thread)
      .where(eq(schema.thread.id, threadId));
    expect(threadsAfter.length).toBe(0);
  });

  it("should cascade delete user's sessions", async () => {
    const { session: adminSession } = await createAdminUser();
    const { user: targetUser, session: targetSession } = await createTestUser({
      db,
    });

    await mockLoggedInUser(adminSession);

    // Verify session exists before deletion
    const sessionsBefore = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.id, targetSession.id));
    expect(sessionsBefore.length).toBe(1);

    // Delete the user
    const result = await deleteUser(targetUser.id);
    expect(result.success).toBe(true);

    // Verify sessions are cascade deleted
    const sessionsAfter = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.id, targetSession.id));
    expect(sessionsAfter.length).toBe(0);
  });
});

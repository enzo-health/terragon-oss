import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import * as schema from "@leo/shared/db/schema";
import { eq } from "drizzle-orm";
import {
  adminOnly,
  userOnlyAction,
  adminOnlyAction,
  getAdminUserOrThrow,
  getUserIdOrNull,
  getUserInfoOrNull,
  validInternalRequestOrThrow,
} from "@/lib/auth-server";
import { createTestUser } from "@leo/shared/model/test-helpers";
import {
  mockLoggedInUser,
  mockLoggedOutUser,
  mockNextHeaders,
} from "@/test-helpers/mock-next";
import { env } from "@leo/env/apps-www";
import { UserFacingError } from "./server-actions";

describe("auth-server", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  describe("userOnlyAction", () => {
    it("should set userOnly and wrappedServerAction properties for testing", () => {
      const mockCallback = vi.fn();
      const wrappedCallback = userOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      expect(wrappedCallback.userOnly).toBe(true);
      expect(wrappedCallback.wrappedServerAction).toBe(true);
    });

    it("should return an error when no user is logged in", async () => {
      await mockLoggedOutUser();
      const mockCallback = vi.fn().mockResolvedValue("data");
      const wrappedCallback = userOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe("Unauthorized");
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it("should return the data when a user is logged in", async () => {
      const { user, session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const mockCallback = vi.fn().mockResolvedValue("data");
      const wrappedCallback = userOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(true);
      expect(result.data).toBe("data");
      expect(mockCallback).toHaveBeenCalledWith(user.id, "arg1", "arg2");
    });

    it("should return an error when the callback throws an error", async () => {
      const { user, session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const mockCallback = vi
        .fn()
        .mockRejectedValue(new UserFacingError("test error"));
      const wrappedCallback = userOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe("test error");
      expect(mockCallback).toHaveBeenCalledWith(user.id, "arg1", "arg2");
    });
  });

  describe("adminOnly", () => {
    it("should set adminOnly property for testing", () => {
      const mockCallback = vi.fn();
      const wrappedCallback = adminOnly(mockCallback);
      expect(wrappedCallback.adminOnly).toBe(true);
    });

    it("should reject non-admin users", async () => {
      const { session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const mockCallback = vi.fn().mockResolvedValue("success");
      const wrappedCallback = adminOnly(mockCallback);
      await expect(wrappedCallback("arg1", "arg2")).rejects.toThrow(
        "Unauthorized",
      );
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it("should reject when no user is logged in", async () => {
      await mockLoggedOutUser();
      const mockCallback = vi.fn().mockResolvedValue("success");
      const wrappedCallback = adminOnly(mockCallback);
      await expect(wrappedCallback("arg1", "arg2")).rejects.toThrow(
        "Unauthorized",
      );
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it("should allow admin users to call the function", async () => {
      const { user, session } = await createTestUser({ db });
      await db
        .update(schema.user)
        .set({ role: "admin" })
        .where(eq(schema.user.id, user.id));
      await mockLoggedInUser(session);
      const mockCallback = vi.fn().mockResolvedValue("success");
      const wrappedCallback = adminOnly(mockCallback);
      const result = await wrappedCallback("arg1", "arg2");
      expect(result).toBe("success");
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({ id: user.id, role: "admin" }),
        "arg1",
        "arg2",
      );
    });
  });

  describe("adminOnlyAction", () => {
    it("should set adminOnly and wrappedServerAction properties for testing", () => {
      const mockCallback = vi.fn();
      const wrappedCallback = adminOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      expect(wrappedCallback.adminOnly).toBe(true);
      expect(wrappedCallback.wrappedServerAction).toBe(true);
    });

    it("should return an error when no admin user is logged in", async () => {
      await mockLoggedOutUser();
      const mockCallback = vi.fn().mockResolvedValue("data");
      const wrappedCallback = adminOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe("Unauthorized");
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it("should reject non-admin users", async () => {
      const { session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const mockCallback = vi.fn().mockResolvedValue("success");
      const wrappedCallback = adminOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe("Unauthorized");
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it("should return the data when a admin user is logged in", async () => {
      const { user, session } = await createTestUser({ db });
      await db
        .update(schema.user)
        .set({ role: "admin" })
        .where(eq(schema.user.id, user.id));
      await mockLoggedInUser(session);
      const mockCallback = vi.fn().mockResolvedValue("data");
      const wrappedCallback = adminOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(true);
      expect(result.data).toBe("data");
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({ id: user.id, role: "admin" }),
        "arg1",
        "arg2",
      );
    });
  });

  describe("getAdminUserOrThrow", () => {
    it("should throw an error when no admin user is logged in", async () => {
      await mockLoggedOutUser();
      await expect(getAdminUserOrThrow()).rejects.toThrow("Unauthorized");
    });

    it("should return the admin user when a admin user is logged in", async () => {
      const { user, session } = await createTestUser({ db });
      await db
        .update(schema.user)
        .set({ role: "admin" })
        .where(eq(schema.user.id, user.id));
      await mockLoggedInUser(session);
      const adminUser = await getAdminUserOrThrow();
      expect(adminUser.id).toBe(user.id);
    });

    it("should throw an error when a non-admin user is logged in", async () => {
      const { session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      await expect(getAdminUserOrThrow()).rejects.toThrow("Unauthorized");
    });
  });

  describe("getUserIdOrNull", () => {
    it("should return null when no user is logged in", async () => {
      await mockLoggedOutUser();
      const userId = await getUserIdOrNull();
      expect(userId).toBeNull();
    });

    it("should return the user id when a user is logged in", async () => {
      const { user, session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const userId = await getUserIdOrNull();
      expect(userId).toBe(user.id);
    });
  });

  describe("getUserInfoOrNull", () => {
    it("should return null when no user is logged in", async () => {
      await mockLoggedOutUser();
      const userInfo = await getUserInfoOrNull();
      expect(userInfo).toBeNull();
    });

    it("should return user info when a user is logged in", async () => {
      const { user, session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const userInfo = await getUserInfoOrNull();
      expect(userInfo).toBeDefined();
      expect(userInfo?.user.id).toBe(user.id);
      expect(userInfo?.session.id).toBe(session.id);
    });
  });

  describe("validInternalRequestOrThrow", () => {
    it("should throw an error when the secret is incorrect", async () => {
      await mockNextHeaders({ "X-Leo-Secret": "incorrect" });
      await expect(validInternalRequestOrThrow()).rejects.toThrow(
        "Unauthorized",
      );
    });

    it("should not throw an error when the secret is correct", async () => {
      await mockNextHeaders({
        "X-Leo-Secret": env.INTERNAL_SHARED_SECRET,
      });
      await validInternalRequestOrThrow();
    });
  });
});

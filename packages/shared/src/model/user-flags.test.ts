import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser } from "./test-helpers";
import { env } from "@leo/env/pkg-shared";
import { createDb } from "../db";
import { User } from "../db/types";
import { getUserFlags, updateUserFlags } from "./user-flags";

const db = createDb(env.DATABASE_URL!);

describe("user-flags", () => {
  let user: User;

  beforeEach(async () => {
    const testUserAndAccount = await createTestUser({ db });
    user = testUserAndAccount.user;
  });

  it("should create default user flags if none exist", async () => {
    const flags = await getUserFlags({ db, userId: user.id });
    expect(flags).toBeDefined();
    expect(flags.userId).toBe(user.id);
    expect(flags.hasSeenOnboarding).toBe(false);
    expect(flags.showDebugTools).toBe(false);
  });

  it("should return existing user flags", async () => {
    const firstCall = await getUserFlags({ db, userId: user.id });
    const secondCall = await getUserFlags({ db, userId: user.id });
    expect(secondCall.id).toBe(firstCall.id);
  });

  it("should update user flags", async () => {
    await getUserFlags({ db, userId: user.id });
    const updated = await updateUserFlags({
      db,
      userId: user.id,
      updates: {
        hasSeenOnboarding: true,
        showDebugTools: true,
      },
    });
    expect(updated.hasSeenOnboarding).toBe(true);
    expect(updated.showDebugTools).toBe(true);
  });

  it("should throw error when trying to update protected fields", async () => {
    await getUserFlags({ db, userId: user.id });
    await expect(
      updateUserFlags({
        db,
        userId: user.id,
        updates: {
          id: "new-id",
        } as any,
      }),
    ).rejects.toThrow();
  });
});

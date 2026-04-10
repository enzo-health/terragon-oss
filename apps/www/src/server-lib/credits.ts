import type { DB } from "@leo/shared/db";
import * as schema from "@leo/shared/db/schema";
import { sql, isNull, and, eq } from "drizzle-orm";
import { getUserCredits, grantUserCredits } from "@leo/shared/model/credits";

const SIGNUP_BONUS_AMOUNT_CENTS = 1000; // $10.00

export async function getUserIdsWithoutSignupBonus({
  db,
}: {
  db: DB;
}): Promise<string[]> {
  const result = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .leftJoin(
      schema.userCredits,
      and(
        eq(schema.user.id, schema.userCredits.userId),
        eq(schema.userCredits.grantType, "signup_bonus"),
      ),
    )
    .where(isNull(schema.userCredits.id));
  return result.map((row) => row.id);
}

export async function getNumberOfUsersWithoutSignupBonus({ db }: { db: DB }) {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.user)
    .leftJoin(
      schema.userCredits,
      and(
        eq(schema.user.id, schema.userCredits.userId),
        eq(schema.userCredits.grantType, "signup_bonus"),
      ),
    )
    .where(isNull(schema.userCredits.id));
  return Number(result[0]?.count ?? 0);
}

export async function maybeGrantSignupBonus({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<void> {
  const existingCredits = await getUserCredits({
    db,
    userId,
    grantType: "signup_bonus",
  });
  if (existingCredits.length > 0) {
    return;
  }
  await grantUserCredits({
    db,
    grants: {
      userId,
      amountCents: SIGNUP_BONUS_AMOUNT_CENTS,
      description: "Signup bonus",
      grantType: "signup_bonus",
      referenceId: `signup-bonus:${userId}`,
    },
  });
}

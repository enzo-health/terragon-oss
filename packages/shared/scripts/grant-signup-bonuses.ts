#!/usr/bin/env tsx
/**
 * Script to grant signup bonuses to users who haven't received them yet
 *
 * This script:
 * 1. Finds all users who don't have a signup_bonus credit grant
 * 2. Grants them a $10 signup bonus
 * 3. Processes in batches to avoid overwhelming the database
 */

import { createDb } from "../src/db";
import * as schema from "../src/db/schema";
import { sql, isNull, and, eq } from "drizzle-orm";
import { env } from "@leo/env/pkg-shared";

const SIGNUP_BONUS_AMOUNT_CENTS = 1000; // $10.00
const BATCH_SIZE = 10;

async function getUsersWithoutSignupBonus(
  db: ReturnType<typeof createDb>,
  limit: number,
): Promise<Array<{ id: string; email: string }>> {
  const result = await db
    .select({ id: schema.user.id, email: schema.user.email })
    .from(schema.user)
    .leftJoin(
      schema.userCredits,
      and(
        eq(schema.user.id, schema.userCredits.userId),
        eq(schema.userCredits.grantType, "signup_bonus"),
      ),
    )
    .where(isNull(schema.userCredits.id))
    .limit(limit);
  return result;
}

async function getNumberOfUsersWithoutSignupBonus(
  db: ReturnType<typeof createDb>,
): Promise<number> {
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

async function maybeGrantSignupBonus(
  db: ReturnType<typeof createDb>,
  userId: string,
  dryRun: boolean,
): Promise<boolean> {
  // Double-check they don't already have the bonus
  const existingCredits = await db
    .select()
    .from(schema.userCredits)
    .where(
      and(
        eq(schema.userCredits.userId, userId),
        eq(schema.userCredits.grantType, "signup_bonus"),
      ),
    );

  if (existingCredits.length > 0) {
    return false;
  }

  if (!dryRun) {
    await db.insert(schema.userCredits).values({
      userId,
      amountCents: SIGNUP_BONUS_AMOUNT_CENTS,
      description: "Signup bonus",
      grantType: "signup_bonus",
      referenceId: `signup-bonus:${userId}`,
    });
  }

  return true;
}

async function grantSignupBonuses(
  db: ReturnType<typeof createDb>,
  options: { dryRun?: boolean; limit?: number } = {},
) {
  const { dryRun = false, limit = 100 } = options;

  const modeInfo = dryRun ? " (DRY RUN)" : "";
  const limitInfo = limit > 0 ? ` - limit ${limit}` : "";
  console.log(`Granting signup bonuses${modeInfo}${limitInfo}`);

  // Get total count
  const totalCount = await getNumberOfUsersWithoutSignupBonus(db);
  console.log(`Found ${totalCount} users without signup bonus`);

  if (totalCount === 0) {
    console.log("No users need signup bonuses");
    return;
  }

  // Get users without bonus (limited by SQL)
  const usersToGrant = await getUsersWithoutSignupBonus(db, limit);

  console.log(`Processing ${usersToGrant.length} users...`);

  let grantedCount = 0;
  let skippedCount = 0;

  // Process in batches
  for (let i = 0; i < usersToGrant.length; i += BATCH_SIZE) {
    const batch = usersToGrant.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (user) => {
        const granted = await maybeGrantSignupBonus(db, user.id, dryRun);
        return { userId: user.id, email: user.email, granted };
      }),
    );

    for (const result of batchResults) {
      if (result.granted) {
        if (dryRun) {
          console.log(
            `  👁️  ${result.email}: Would grant $${SIGNUP_BONUS_AMOUNT_CENTS / 100}`,
          );
        } else {
          console.log(
            `  ✅ ${result.email}: Granted $${SIGNUP_BONUS_AMOUNT_CENTS / 100}`,
          );
        }
        grantedCount++;
      } else {
        console.log(`  ⏭️  ${result.email}: Already has signup bonus`);
        skippedCount++;
      }
    }

    // Small delay between batches
    if (i + BATCH_SIZE < usersToGrant.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  console.log(
    `\nComplete: ${grantedCount} ${dryRun ? "would be granted" : "granted"}, ${skippedCount} skipped`,
  );
}

// Run the script if this file is executed directly
async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);

  // Default to dry run unless explicitly disabled
  const dryRun = !args.includes("--no-dry-run");
  const limit = parseInt(
    args.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || "100",
    10,
  );

  // Show help if requested
  if (args.includes("--help")) {
    console.log(
      "Usage: pnpm exec tsx scripts/grant-signup-bonuses.ts [options]",
    );
    console.log("");
    console.log("Options:");
    console.log(
      "  --no-dry-run      Actually grant the bonuses (default is dry run)",
    );
    console.log(
      "  --limit=<number>  Maximum number of users to process (default: 100)",
    );
    console.log("  --help            Show this help message");
    console.log("");
    console.log("Examples:");
    console.log("  pnpm exec tsx scripts/grant-signup-bonuses.ts");
    console.log("  pnpm exec tsx scripts/grant-signup-bonuses.ts --no-dry-run");
    console.log(
      "  pnpm exec tsx scripts/grant-signup-bonuses.ts --no-dry-run --limit=50",
    );
    console.log("");
    process.exit(0);
  }

  const db = createDb(env.DATABASE_URL);
  await grantSignupBonuses(db, { dryRun, limit });
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Failed:", error);
    process.exit(1);
  });

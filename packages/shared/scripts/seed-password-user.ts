#!/usr/bin/env tsx

import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db";
import * as schema from "../src/db/schema";
import { env } from "@terragon/env/pkg-shared";

const SEEDED_EMAIL = "drew@enzo.health";
const SEEDED_PASSWORD = "user1234";
const SEEDED_NAME = "Drew";

async function hasCredentialAccount(
  db: ReturnType<typeof createDb>,
  userId: string,
) {
  const account = await db.query.account.findFirst({
    where: and(
      eq(schema.account.userId, userId),
      eq(schema.account.providerId, "credential"),
    ),
  });
  return Boolean(account);
}

async function run() {
  const db = createDb(env.DATABASE_URL);

  const existingUser = await db.query.user.findFirst({
    where: eq(schema.user.email, SEEDED_EMAIL),
  });

  if (existingUser) {
    const credentialExists = await hasCredentialAccount(db, existingUser.id);
    if (credentialExists) {
      await db
        .update(schema.user)
        .set({ role: "admin", emailVerified: true })
        .where(eq(schema.user.id, existingUser.id));
      console.log(
        `Seed ensured: ${SEEDED_EMAIL} already has a credential account and admin role.`,
      );
      return;
    }
    throw new Error(
      `User ${SEEDED_EMAIL} exists without a credential account. Handle this case manually.`,
    );
  }

  const baseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000";
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: SEEDED_EMAIL,
      password: SEEDED_PASSWORD,
      name: SEEDED_NAME,
      callbackURL: "/dashboard",
    }),
  });

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch {
      errorBody = "<unreadable response>";
    }
    throw new Error(
      `Failed to seed user via Better Auth (${response.status}): ${errorBody}`,
    );
  }

  const seededUser = await db.query.user.findFirst({
    where: eq(schema.user.email, SEEDED_EMAIL),
  });

  if (!seededUser) {
    throw new Error(
      `Sign-up succeeded but seeded user ${SEEDED_EMAIL} was not found in DB.`,
    );
  }

  await db
    .update(schema.user)
    .set({ emailVerified: true, role: "admin" })
    .where(eq(schema.user.id, seededUser.id));

  const credentialExists = await hasCredentialAccount(db, seededUser.id);
  if (!credentialExists) {
    throw new Error(
      `Seeded user ${SEEDED_EMAIL} was created without a credential account.`,
    );
  }

  console.log(`Seeded credential admin user: ${SEEDED_EMAIL}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

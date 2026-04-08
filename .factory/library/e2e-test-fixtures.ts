/**
 * Deterministic Local E2E Test Fixtures
 *
 * This module provides deterministic fixture data for real-mode e2e validation
 * paths (VAL-CLI-008 timeout path and VAL-CLI-010 success payload path).
 *
 * The fixtures are designed to work with the local delivery-loop:local e2e
 * command and provide reproducible inputs for user-testing validators.
 */

import { Client } from "pg";

export const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/postgres";

// Deterministic fixture IDs for reproducible tests
export const E2E_FIXTURE_USER_ID = "e2e-test-user-001";
export const E2E_FIXTURE_REPO = "terragon/e2e-test-repo";

export interface E2EFixtureData {
  userId: string;
  repoFullName: string;
  threadId: string | null;
  workflowId: string | null;
  baseBranch: string;
  headBranch: string | null;
  createdAt: Date | null;
}

/**
 * Checks if the e2e fixture data exists in the database
 */
export async function checkE2EFixturesExist(): Promise<E2EFixtureData> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
  await client.connect();

  try {
    // Check for fixture user
    const userResult = await client.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM "user" WHERE id = $1`,
      [E2E_FIXTURE_USER_ID],
    );

    // Check for most recent thread/workflow for this user
    const threadResult = await client.query<{
      thread_id: string;
      workflow_id: string;
      github_repo_full_name: string;
      current_branch_name: string | null;
      created_at: Date;
    }>(
      `SELECT
        t.id as thread_id,
        dw.id as workflow_id,
        t.github_repo_full_name,
        t.current_branch_name,
        t.created_at
       FROM thread t
       LEFT JOIN delivery_workflow dw ON dw.thread_id = t.id
       WHERE t.user_id = $1
         AND t.github_repo_full_name = $2
       ORDER BY t.created_at DESC
       LIMIT 1`,
      [E2E_FIXTURE_USER_ID, E2E_FIXTURE_REPO],
    );

    const row = threadResult.rows[0];

    return {
      userId: E2E_FIXTURE_USER_ID,
      repoFullName: E2E_FIXTURE_REPO,
      threadId: row?.thread_id ?? null,
      workflowId: row?.workflow_id ?? null,
      baseBranch: "main",
      headBranch: row?.current_branch_name ?? null,
      createdAt: row?.created_at ?? null,
    };
  } finally {
    await client.end();
  }
}

/**
 * Seeds deterministic e2e fixture data in the database
 * This creates a test user with known IDs for reproducible e2e tests
 */
export async function seedE2EFixtures(): Promise<E2EFixtureData> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
  await client.connect();

  try {
    // Create fixture user if not exists
    await client.query(
      `INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, true, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
      [E2E_FIXTURE_USER_ID, "e2e-test@terragon.com", "E2E Test User"],
    );

    // Create GitHub account for the user
    await client.query(
      `INSERT INTO account (id, user_id, provider_id, account_id, access_token, refresh_token, created_at, updated_at)
       VALUES ($1, $2, 'github', $3, 'test-token', 'test-refresh', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        `e2e-account-${E2E_FIXTURE_USER_ID}`,
        E2E_FIXTURE_USER_ID,
        `gh-e2e-${E2E_FIXTURE_USER_ID}`,
      ],
    );

    // Create session for the user
    await client.query(
      `INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        `e2e-session-${E2E_FIXTURE_USER_ID}`,
        E2E_FIXTURE_USER_ID,
        `e2e-token-${E2E_FIXTURE_USER_ID}`,
      ],
    );

    // Create subscription for access tier
    await client.query(
      `INSERT INTO subscription (id, plan, status, "periodStart", "periodEnd", "referenceId", created_at, updated_at)
       VALUES ($1, 'core', 'active', NOW() - INTERVAL '30 days', NOW() + INTERVAL '30 days', $2, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [`e2e-sub-${E2E_FIXTURE_USER_ID}`, E2E_FIXTURE_USER_ID],
    );

    // Return current fixture status
    return await checkE2EFixturesExist();
  } finally {
    await client.end();
  }
}

/**
 * Cleans up e2e fixture data (for test isolation)
 */
export async function cleanupE2EFixtures(): Promise<void> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
  await client.connect();

  try {
    // Delete threads and related data for fixture user
    await client.query(`DELETE FROM thread WHERE user_id = $1`, [
      E2E_FIXTURE_USER_ID,
    ]);

    // Delete user data
    await client.query(`DELETE FROM session WHERE user_id = $1`, [
      E2E_FIXTURE_USER_ID,
    ]);
    await client.query(`DELETE FROM account WHERE user_id = $1`, [
      E2E_FIXTURE_USER_ID,
    ]);
    await client.query(`DELETE FROM subscription WHERE reference_id = $1`, [
      E2E_FIXTURE_USER_ID,
    ]);
    await client.query(`DELETE FROM "user" WHERE id = $1`, [
      E2E_FIXTURE_USER_ID,
    ]);
  } finally {
    await client.end();
  }
}

// CLI execution for direct script usage
async function main() {
  if (import.meta.main) {
    const command = process.argv[2];

    switch (command) {
      case "check": {
        const fixtures = await checkE2EFixturesExist();
        console.log(JSON.stringify(fixtures, null, 2));
        process.exit(0);
        break;
      }
      case "seed": {
        const fixtures = await seedE2EFixtures();
        console.log("E2E fixtures seeded:");
        console.log(JSON.stringify(fixtures, null, 2));
        process.exit(0);
        break;
      }
      case "cleanup": {
        await cleanupE2EFixtures();
        console.log("E2E fixtures cleaned up");
        process.exit(0);
        break;
      }
      default: {
        console.log(`Usage: tsx e2e-test-fixtures.ts [check|seed|cleanup]`);
        process.exit(1);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

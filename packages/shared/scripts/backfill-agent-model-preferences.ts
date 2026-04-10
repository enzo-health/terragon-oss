#!/usr/bin/env tsx
/**
 * Backfill script for agentModelPreferences field in user_settings table
 *
 * This script:
 * 1. Finds users who have used special agents (gemini, amp) or models (opus, gpt-5 variants) in the last 2 weeks
 * 2. Skips users who already have agentModelPreferences set
 * 3. Updates user_settings with the discovered preferences
 * 4. Excludes threads from automations
 */

import { createDb } from "../src/db";
import * as schema from "../src/db/schema";
import { sql } from "drizzle-orm";
import { env } from "@leo/env/pkg-shared";

type AgentModelPreferences = {
  agents?: Record<string, boolean>;
  models?: Record<string, boolean>;
};

type UserPreference = {
  user_id: string;
  email: string;
  agent_model_preferences: AgentModelPreferences;
};

async function backfillAgentModelPreferences(
  db: ReturnType<typeof createDb>,
  options: { dryRun?: boolean; limit?: number; offset?: number } = {},
) {
  const { dryRun = false, limit = 50, offset = 0 } = options;

  const modeInfo = dryRun ? " (DRY RUN)" : "";
  const limitInfo = limit > 0 ? ` - limit ${limit}` : "";
  const offsetInfo = offset > 0 ? `, offset ${offset}` : "";
  console.log(
    `Backfilling agentModelPreferences${modeInfo}${limitInfo}${offsetInfo}`,
  );

  // Execute the query to find users who have used agents/models in the last 2 weeks
  // and don't already have agentModelPreferences set
  const result = await db.execute<UserPreference>(sql`
    WITH user_preferences AS (
      SELECT
        t."user_id",
        jsonb_object_agg(
          DISTINCT t.agent,
          true
        ) FILTER (WHERE t.agent IN ('gemini', 'amp')) as agents,
        jsonb_object_agg(
          DISTINCT m->>'model',
          true
        ) FILTER (WHERE m->>'model' IN (
          'opus',
          'gpt-5', 'gpt-5-low', 'gpt-5-high'
        )) as models
      FROM thread t
      LEFT JOIN LATERAL jsonb_array_elements(t.messages) as m ON true
      WHERE t."created_at" >= NOW() - INTERVAL '2 weeks' AND t."automation_id" is NULL
      GROUP BY t."user_id"
    )
    SELECT
      u.id as user_id,
      u.email,
      jsonb_build_object(
        'agents', COALESCE(up.agents, '{}'::jsonb),
        'models', COALESCE(up.models, '{}'::jsonb)
      ) as agent_model_preferences
    FROM "user" u
    JOIN user_preferences up ON up."user_id" = u.id
    LEFT JOIN user_settings us ON us.user_id = u.id
    WHERE (up.agents IS NOT NULL OR up.models IS NOT NULL)
      AND us.agent_model_preferences IS NULL
    ORDER BY u.id
    LIMIT ${limit} OFFSET ${offset}
  `);

  const users = result.rows;
  console.log(`Found ${users.length} users to process`);

  if (users.length === 0) {
    console.log("No users need updating");
    return;
  }

  let updatedCount = 0;

  for (const user of users) {
    const agentsStr = user.agent_model_preferences.agents
      ? Object.keys(user.agent_model_preferences.agents).join(", ")
      : "none";
    const modelsStr = user.agent_model_preferences.models
      ? Object.keys(user.agent_model_preferences.models).join(", ")
      : "none";

    if (dryRun) {
      console.log(
        `  👁️  ${user.email}: agents=[${agentsStr}], models=[${modelsStr}]`,
      );
      updatedCount++;
    } else {
      try {
        await db
          .insert(schema.userSettings)
          .values({
            userId: user.user_id,
            agentModelPreferences: user.agent_model_preferences,
          })
          .onConflictDoUpdate({
            target: [schema.userSettings.userId],
            set: {
              agentModelPreferences: user.agent_model_preferences,
            },
          });

        console.log(
          `  ✅ ${user.email}: agents=[${agentsStr}], models=[${modelsStr}]`,
        );
        updatedCount++;
      } catch (error) {
        console.log(
          `  ❌ ${user.email}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }
  }

  console.log(
    `\nComplete: ${updatedCount} ${dryRun ? "would be updated" : "updated"}`,
  );
}

// Run the backfill if this file is executed directly
async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);

  // Default to dry run unless explicitly disabled
  const dryRun = !args.includes("--no-dry-run");
  const limit = parseInt(
    args.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || "50",
    10,
  );
  const offset = parseInt(
    args.find((arg) => arg.startsWith("--offset="))?.split("=")[1] || "0",
    10,
  );

  // Show help if requested
  if (args.includes("--help")) {
    console.log(
      "Usage: pnpm exec tsx scripts/backfill-agent-model-preferences.ts [options]",
    );
    console.log("");
    console.log("Options:");
    console.log(
      "  --no-dry-run      Actually perform the updates (default is dry run)",
    );
    console.log(
      "  --limit=<number>  Maximum number of users to process (default: 50)",
    );
    console.log("  --offset=<number> Number of users to skip (default: 0)");
    console.log("  --help            Show this help message");
    console.log("");
    console.log("Examples:");
    console.log("  pnpm exec tsx scripts/backfill-agent-model-preferences.ts");
    console.log(
      "  pnpm exec tsx scripts/backfill-agent-model-preferences.ts --no-dry-run",
    );
    console.log(
      "  pnpm exec tsx scripts/backfill-agent-model-preferences.ts --no-dry-run --limit=100",
    );
    console.log(
      "  pnpm exec tsx scripts/backfill-agent-model-preferences.ts --no-dry-run --limit=50 --offset=50",
    );
    console.log("");
    process.exit(0);
  }

  const db = createDb(env.DATABASE_URL);
  await backfillAgentModelPreferences(db, { dryRun, limit, offset });
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Failed:", error);
    process.exit(1);
  });

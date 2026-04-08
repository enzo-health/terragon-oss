/**
 * Drizzle Schema Code Changes for Migration 001
 *
 * These are the TypeScript/Drizzle schema changes that should be applied
 * to packages/shared/src/db/schema.ts AFTER the SQL migration has been
 * successfully executed on the database.
 *
 * IMPORTANT: This is a documentation/tracking file. The actual changes
 * need to be applied to schema.ts manually or via the provided patch.
 */

// =============================================================================
// CHANGES TO APPLY TO packages/shared/src/db/schema.ts
// =============================================================================

// -----------------------------------------------------------------------------
// 1. USER_FLAGS TABLE - Remove deprecated column (around line 1062-1063)
// -----------------------------------------------------------------------------

// BEFORE:
// export const userFlags = pgTable(
//   "user_flags",
//   {
//     // ... other columns ...
//     // @deprecated Use lastSeenReleaseNotesVersion instead
//     lastSeenReleaseNotes: timestamp("last_seen_release_notes"),
//     lastSeenReleaseNotesVersion: integer("last_seen_release_notes_version"),
//     // ... rest of columns ...
//   },
//   // ...
// );

// AFTER:
// export const userFlags = pgTable(
//   "user_flags",
//   {
//     // ... other columns ...
//     lastSeenReleaseNotesVersion: integer("last_seen_release_notes_version"),
//     // ... rest of columns ...
//   },
//   // ...
// );

// -----------------------------------------------------------------------------
// 2. ONBOARDING_QUESTIONNAIRE TABLE - Remove deprecated columns (around line 269-271)
// -----------------------------------------------------------------------------

// BEFORE:
// export const onboardingQuestionnaire = pgTable(
//   "onboarding_questionnaire",
//   {
//     // ... other columns ...
//     createdAt: timestamp("created_at").notNull().defaultNow(),
//     // Keep old columns for backwards compatibility during migration
//     primaryUseDeprecated: text("primary_use"),
//     feedbackWillingnessDeprecated: text("feedback_willingness"),
//     interviewWillingnessDeprecated: text("interview_willingness"),
//   },
//   // ...
// );

// AFTER:
// export const onboardingQuestionnaire = pgTable(
//   "onboarding_questionnaire",
//   {
//     // ... other columns ...
//     createdAt: timestamp("created_at").notNull().defaultNow(),
//   },
//   // ...
// );

// -----------------------------------------------------------------------------
// 3. ENVIRONMENT TABLE - Remove deprecated column (around line 686)
// -----------------------------------------------------------------------------

// BEFORE:
// export const environment = pgTable(
//   "environment",
//   {
//     // ... other columns ...
//     snapshots: jsonb("snapshots").$type<EnvironmentSnapshot[]>().default([]),
//     DEPRECATED_disableGitCheckpointing: boolean("disable_git_checkpointing")
//       .notNull()
//       .default(false),
//     createdAt: timestamp("created_at").notNull().defaultNow(),
//     // ...
//   },
//   // ...
// );

// AFTER:
// export const environment = pgTable(
//   "environment",
//   {
//     // ... other columns ...
//     snapshots: jsonb("snapshots").$type<EnvironmentSnapshot[]>().default([]),
//     createdAt: timestamp("created_at").notNull().defaultNow(),
//     // ...
//   },
//   // ...
// );

// -----------------------------------------------------------------------------
// 4. DEPRECATED TABLES - Remove entire table definitions (around lines 704-780)
// -----------------------------------------------------------------------------

// BEFORE:
// // Deprecated: UNUSED - replaced by agent_provider_credentials table
// export const claudeOAuthTokens_DEPRECATED = pgTable("claude_oauth_tokens", {
//   id: text("id")
//     .default(sql`gen_random_uuid()`)
//     .primaryKey(),
//   userId: text("user_id")
//     .notNull()
//     .references(() => user.id, { onDelete: "cascade" })
//     .unique(), // One token per user
//   isSubscription: boolean("is_subscription").notNull().default(true),
//   anthropicApiKeyEncrypted: text("anthropic_api_key_encrypted"),
//   accessTokenEncrypted: text("access_token_encrypted").notNull(),
//   tokenType: text("token_type").notNull(),
//   expiresAt: timestamp("expires_at", { mode: "date" }),
//   refreshTokenEncrypted: text("refresh_token_encrypted"),
//   scope: text("scope"),
//   isMax: boolean("is_max").default(false).notNull(),
//   organizationType: text("organization_type").$type<ClaudeOrganizationType>(),
//   accountId: text("account_id"),
//   accountEmail: text("account_email"),
//   orgId: text("org_id"),
//   orgName: text("org_name"),
//   createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
//   updatedAt: timestamp("updated_at", { mode: "date" })
//     .defaultNow()
//     .notNull()
//     .$onUpdate(() => new Date()),
// });

// // Deprecated: UNUSED - replaced by agent_provider_credentials table
// export const geminiAuth_DEPRECATED = pgTable("gemini_auth", {
//   // ... full table definition ...
// });

// // Deprecated: UNUSED - replaced by agent_provider_credentials table
// export const ampAuth_DEPRECATED = pgTable("amp_auth", {
//   // ... full table definition ...
// });

// // Deprecated: UNUSED - replaced by agent_provider_credentials table
// export const openAIAuth_DEPRECATED = pgTable("openai_auth", {
//   // ... full table definition ...
// });

// AFTER:
// (Remove all of the above - nothing to replace them with)

// =============================================================================
// ROLLBACK CODE (for reference only - use database backup for actual rollback)
// =============================================================================

// To rollback schema changes:
// 1. Restore the database from pre-migration backup
// 2. Revert the schema.ts changes using git:
//    git checkout HEAD~1 -- packages/shared/src/db/schema.ts
// 3. Rebuild and redeploy the application

// =============================================================================
// TYPE SAFETY NOTES
// =============================================================================

// After removing these columns from the schema:
// 1. The TypeScript compiler will catch any accidental references to:
//    - userFlags.lastSeenReleaseNotes
//    - onboardingQuestionnaire.primaryUseDeprecated
//    - onboardingQuestionnaire.feedbackWillingnessDeprecated
//    - onboardingQuestionnaire.interviewWillingnessDeprecated
//    - environment.DEPRECATED_disableGitCheckpointing
//    - claudeOAuthTokens_DEPRECATED
//    - geminiAuth_DEPRECATED
//    - ampAuth_DEPRECATED
//    - openAIAuth_DEPRECATED
//
// 2. Run `pnpm tsc-check` to verify no type errors exist after schema changes
//
// 3. Run `pnpm -C packages/shared test` to ensure database model tests pass

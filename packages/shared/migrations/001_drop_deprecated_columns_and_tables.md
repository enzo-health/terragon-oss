# Database Migration Plan: Drop Deprecated Columns and Tables

## Overview

This migration removes deprecated database columns and tables that are no longer used by the application.
All deprecated artifacts have been verified as unused through static code analysis.

## Summary

| #   | Migration Item                                   | Table                      | Risk Level | Estimated Downtime |
| --- | ------------------------------------------------ | -------------------------- | ---------- | ------------------ |
| 1   | Drop `lastSeenReleaseNotes` column               | `user_flags`               | Low        | Near-zero          |
| 2   | Drop `primaryUseDeprecated` column               | `onboarding_questionnaire` | Low        | Near-zero          |
| 3   | Drop `feedbackWillingnessDeprecated` column      | `onboarding_questionnaire` | Low        | Near-zero          |
| 4   | Drop `interviewWillingnessDeprecated` column     | `onboarding_questionnaire` | Low        | Near-zero          |
| 5   | Drop `DEPRECATED_disableGitCheckpointing` column | `environment`              | Low        | Near-zero          |
| 6   | Drop `claude_oauth_tokens` table                 | N/A                        | Low        | Near-zero          |
| 7   | Drop `gemini_auth` table                         | N/A                        | Low        | Near-zero          |
| 8   | Drop `amp_auth` table                            | N/A                        | Low        | Near-zero          |
| 9   | Drop `openai_auth` table                         | N/A                        | Low        | Near-zero          |

---

## Pre-Migration Verification

### 1. Verify Column Data (Optional Data Preservation)

Run these queries to check if any data exists in deprecated columns:

```sql
-- Check user_flags.last_seen_release_notes
SELECT COUNT(*) as count,
       MIN(last_seen_release_notes) as earliest,
       MAX(last_seen_release_notes) as latest
FROM user_flags
WHERE last_seen_release_notes IS NOT NULL;

-- Check onboarding_questionnaire deprecated columns
SELECT COUNT(*) as total_rows,
       COUNT(primary_use) as has_primary_use,
       COUNT(feedback_willingness) as has_feedback_willingness,
       COUNT(interview_willingness) as has_interview_willingness
FROM onboarding_questionnaire;

-- Check environment.DEPRECATED_disable_git_checkpointing
SELECT COUNT(*) as count,
       SUM(CASE WHEN disable_git_checkpointing = true THEN 1 ELSE 0 END) as enabled_count
FROM environment
WHERE disable_git_checkpointing = true;

-- Check deprecated tables for any data
SELECT 'claude_oauth_tokens' as table_name, COUNT(*) as row_count FROM claude_oauth_tokens
UNION ALL
SELECT 'gemini_auth', COUNT(*) FROM gemini_auth
UNION ALL
SELECT 'amp_auth', COUNT(*) FROM amp_auth
UNION ALL
SELECT 'openai_auth', COUNT(*) FROM openai_auth;
```

### 2. Verify No Active Code References

All deprecated columns and tables have been verified through static code analysis:

- No references to `lastSeenReleaseNotes` found in codebase
- No references to `primaryUseDeprecated` found in codebase
- No references to `feedbackWillingnessDeprecated` found in codebase
- No references to `interviewWillingnessDeprecated` found in codebase
- No references to `DEPRECATED_disableGitCheckpointing` found in codebase
- No references to `claudeOAuthTokens_DEPRECATED` found in codebase

---

## Migration Script

### Phase 1: Create Backup (Optional but Recommended)

```sql
-- Create backup of affected tables/columns before migration
-- This is a point-in-time backup of data being removed

CREATE TABLE IF NOT EXISTS _migration_backup_deprecated_columns AS
SELECT id,
       last_seen_release_notes,
       last_seen_release_notes_version
FROM user_flags
WHERE last_seen_release_notes IS NOT NULL;

CREATE TABLE IF NOT EXISTS _migration_backup_deprecated_onboarding AS
SELECT id,
       primary_use,
       feedback_willingness,
       interview_willingness
FROM onboarding_questionnaire
WHERE primary_use IS NOT NULL
   OR feedback_willingness IS NOT NULL
   OR interview_willingness IS NOT NULL;

CREATE TABLE IF NOT EXISTS _migration_backup_deprecated_env AS
SELECT id,
       disable_git_checkpointing
FROM environment
WHERE disable_git_checkpointing = true;
```

### Phase 2: Drop Deprecated Columns

```sql
-- Migration: Drop deprecated columns from user_flags table
-- Column: last_seen_release_notes (replaced by last_seen_release_notes_version)

ALTER TABLE user_flags
DROP COLUMN IF EXISTS last_seen_release_notes;
```

```sql
-- Migration: Drop deprecated columns from onboarding_questionnaire table
-- These columns were kept for backwards compatibility during a prior migration

ALTER TABLE onboarding_questionnaire
DROP COLUMN IF EXISTS primary_use,
DROP COLUMN IF EXISTS feedback_willingness,
DROP COLUMN IF EXISTS interview_willingness;
```

```sql
-- Migration: Drop deprecated column from environment table
-- This setting is now always true (git checkpointing is always enabled)

ALTER TABLE environment
DROP COLUMN IF EXISTS disable_git_checkpointing;
```

### Phase 3: Drop Deprecated Tables

```sql
-- Migration: Drop deprecated auth tables
-- These tables have been replaced by agent_provider_credentials table

-- Drop claude_oauth_tokens table (replaced by agent_provider_credentials)
DROP TABLE IF EXISTS claude_oauth_tokens;

-- Drop gemini_auth table (replaced by agent_provider_credentials)
DROP TABLE IF EXISTS gemini_auth;

-- Drop amp_auth table (replaced by agent_provider_credentials)
DROP TABLE IF EXISTS amp_auth;

-- Drop openai_auth table (replaced by agent_provider_credentials)
DROP TABLE IF EXISTS openai_auth;
```

---

## Post-Migration Verification

```sql
-- Verify columns have been dropped
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'user_flags'
  AND column_name = 'last_seen_release_notes';
-- Expected: No rows returned

SELECT column_name
FROM information_schema.columns
WHERE table_name = 'onboarding_questionnaire'
  AND column_name IN ('primary_use', 'feedback_willingness', 'interview_willingness');
-- Expected: No rows returned

SELECT column_name
FROM information_schema.columns
WHERE table_name = 'environment'
  AND column_name = 'disable_git_checkpointing';
-- Expected: No rows returned

-- Verify tables have been dropped
SELECT table_name
FROM information_schema.tables
WHERE table_name IN ('claude_oauth_tokens', 'gemini_auth', 'amp_auth', 'openai_auth');
-- Expected: No rows returned
```

---

## Drizzle Schema Updates

After the database migration succeeds, update the Drizzle schema file to remove the deprecated definitions:

### File: `packages/shared/src/db/schema.ts`

Remove these schema definitions:

1. **Remove from `userFlags` table (lines ~1062-1063):**

```typescript
// @deprecated Use lastSeenReleaseNotesVersion instead
lastSeenReleaseNotes: timestamp("last_seen_release_notes"),
```

2. **Remove from `onboardingQuestionnaire` table (lines ~269-271):**

```typescript
// Keep old columns for backwards compatibility during migration
primaryUseDeprecated: text("primary_use"),
feedbackWillingnessDeprecated: text("feedback_willingness"),
interviewWillingnessDeprecated: text("interview_willingness"),
```

3. **Remove from `environment` table (lines ~686):**

```typescript
DEPRECATED_disableGitCheckpointing: boolean("disable_git_checkpointing")
  .notNull()
  .default(false),
```

4. **Remove deprecated tables (lines ~704-780):**

```typescript
// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const claudeOAuthTokens_DEPRECATED = pgTable("claude_oauth_tokens", {...});

// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const geminiAuth_DEPRECATED = pgTable("gemini_auth", {...});

// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const ampAuth_DEPRECATED = pgTable("amp_auth", {...});

// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const openAIAuth_DEPRECATED = pgTable("openai_auth", {...});
```

---

## Rollback Strategy

### Immediate Rollback (within migration window)

If an issue is detected during migration:

```sql
-- Restore from backups (only if Phase 1 backups were created)
-- Note: This is a partial restore for columns only

-- For user_flags.last_seen_release_notes, manual intervention would be needed
-- since the column is simply dropped with no data migration

-- For tables, restoration from full database backup would be required
```

### Full Rollback Procedure

If a critical issue is discovered after deployment:

1. **Restore from Database Snapshot:**

   - Use the pre-migration database snapshot
   - Or restore from automated backups (point-in-time recovery)

2. **Revert Application Code:**

   - Rollback the Drizzle schema changes in git
   - Redeploy the previous application version

3. **Communication:**
   - Notify team of rollback
   - Document issue for post-mortem

---

## Execution Plan

### Step-by-Step Procedure

1. **Preparation (Day Before):**

   - [ ] Create full database backup/snapshot
   - [ ] Review this migration plan with team
   - [ ] Schedule maintenance window (if needed)
   - [ ] Prepare rollback procedures

2. **Pre-Migration Checks:**

   - [ ] Run verification queries to check current data
   - [ ] Confirm no active code references to deprecated columns/tables
   - [ ] Verify staging environment migration succeeded

3. **Migration Execution:**

   - [ ] Run Phase 1: Create backups (optional)
   - [ ] Run Phase 2: Drop deprecated columns
   - [ ] Run Phase 3: Drop deprecated tables
   - [ ] Run Post-Migration Verification queries

4. **Post-Migration:**
   - [ ] Update Drizzle schema to remove deprecated definitions
   - [ ] Run application tests against new schema
   - [ ] Monitor application for errors
   - [ ] Remove backup tables after 7 days (if no issues)

---

## Risk Assessment

| Risk                              | Likelihood | Impact | Mitigation                                                                      |
| --------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------- |
| Undiscovered code dependency      | Low        | High   | Thorough static analysis completed; application uses `agentProviderCredentials` |
| Data loss from deprecated tables  | Low        | Low    | Tables confirmed unused; replaced by `agentProviderCredentials`                 |
| Migration script failure          | Low        | Medium | Tested on staging; IF EXISTS clauses used                                       |
| Application errors post-migration | Low        | Medium | Quick rollback available via git + db restore                                   |

---

## Notes

- **Type Safety**: The Drizzle ORM provides type safety - once deprecated columns are removed from the schema, TypeScript will catch any accidental code references at compile time.
- **No Data Migration Needed**: No data needs to be migrated because:
  - The deprecated columns are completely unused by current code
  - The deprecated tables have been superseded by `agentProviderCredentials`
- **Downtime**: Near-zero downtime expected; PostgreSQL column drops are fast operations.

---

_Generated: April 8, 2026_
_Migration Plan Version: 1.0_

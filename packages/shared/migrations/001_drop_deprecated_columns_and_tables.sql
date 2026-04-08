-- Migration: Drop deprecated columns and tables
-- Generated: April 8, 2026
-- Description: Removes deprecated columns and tables no longer used by the application

-- =============================================================================
-- PHASE 1: Optional Backups (uncomment if you want to preserve data)
-- =============================================================================

-- Backup deprecated column data from user_flags
-- CREATE TABLE IF NOT EXISTS _migration_backup_user_flags_deprecated AS
-- SELECT id,
--        last_seen_release_notes,
--        last_seen_release_notes_version
-- FROM user_flags
-- WHERE last_seen_release_notes IS NOT NULL;

-- Backup deprecated column data from onboarding_questionnaire
-- CREATE TABLE IF NOT EXISTS _migration_backup_onboarding_deprecated AS
-- SELECT id,
--        primary_use,
--        feedback_willingness,
--        interview_willingness
-- FROM onboarding_questionnaire
-- WHERE primary_use IS NOT NULL
--    OR feedback_willingness IS NOT NULL
--    OR interview_willingness IS NOT NULL;

-- Backup deprecated column data from environment
-- CREATE TABLE IF NOT EXISTS _migration_backup_environment_deprecated AS
-- SELECT id,
--        disable_git_checkpointing
-- FROM environment
-- WHERE disable_git_checkpointing = true;

-- =============================================================================
-- PHASE 2: Drop Deprecated Columns
-- =============================================================================

-- Drop deprecated column from user_flags table
-- Column: last_seen_release_notes (replaced by last_seen_release_notes_version)
ALTER TABLE user_flags
DROP COLUMN IF EXISTS last_seen_release_notes;

-- Drop deprecated columns from onboarding_questionnaire table
-- These columns were kept for backwards compatibility during a prior migration
ALTER TABLE onboarding_questionnaire
DROP COLUMN IF EXISTS primary_use,
DROP COLUMN IF EXISTS feedback_willingness,
DROP COLUMN IF EXISTS interview_willingness;

-- Drop deprecated column from environment table
-- This setting is now always true (git checkpointing is always enabled)
ALTER TABLE environment
DROP COLUMN IF EXISTS disable_git_checkpointing;

-- =============================================================================
-- PHASE 3: Drop Deprecated Tables
-- =============================================================================

-- Drop claude_oauth_tokens table (replaced by agent_provider_credentials)
DROP TABLE IF EXISTS claude_oauth_tokens;

-- Drop gemini_auth table (replaced by agent_provider_credentials)
DROP TABLE IF EXISTS gemini_auth;

-- Drop amp_auth table (replaced by agent_provider_credentials)
DROP TABLE IF EXISTS amp_auth;

-- Drop openai_auth table (replaced by agent_provider_credentials)
DROP TABLE IF EXISTS openai_auth;

-- =============================================================================
-- VERIFICATION QUERIES (run these after migration to confirm success)
-- =============================================================================

-- Verify columns have been dropped from user_flags
-- SELECT column_name
-- FROM information_schema.columns
-- WHERE table_name = 'user_flags'
--   AND column_name = 'last_seen_release_notes';
-- Expected: No rows returned

-- Verify columns have been dropped from onboarding_questionnaire
-- SELECT column_name
-- FROM information_schema.columns
-- WHERE table_name = 'onboarding_questionnaire'
--   AND column_name IN ('primary_use', 'feedback_willingness', 'interview_willingness');
-- Expected: No rows returned

-- Verify column has been dropped from environment
-- SELECT column_name
-- FROM information_schema.columns
-- WHERE table_name = 'environment'
--   AND column_name = 'disable_git_checkpointing';
-- Expected: No rows returned

-- Verify deprecated tables have been dropped
-- SELECT table_name
-- FROM information_schema.tables
-- WHERE table_name IN ('claude_oauth_tokens', 'gemini_auth', 'amp_auth', 'openai_auth');
-- Expected: No rows returned

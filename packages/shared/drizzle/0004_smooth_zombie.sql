WITH "ranked_duplicates" AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "loop_id", "cause_type", "canonical_cause_id", "cause_identity_version"
      ORDER BY ("processed_at" IS NOT NULL) DESC, "received_at" ASC, "id" ASC
    ) AS "duplicate_rank"
  FROM "sdlc_loop_signal_inbox"
  WHERE "signal_head_sha_or_null" IS NULL
)
DELETE FROM "sdlc_loop_signal_inbox" AS "signal_inbox"
USING "ranked_duplicates"
WHERE "signal_inbox"."id" = "ranked_duplicates"."id"
  AND "ranked_duplicates"."duplicate_rank" > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_loop_signal_inbox_dedupe_null_head_unique" ON "sdlc_loop_signal_inbox" USING btree ("loop_id","cause_type","canonical_cause_id","cause_identity_version") WHERE "sdlc_loop_signal_inbox"."signal_head_sha_or_null" is null;
